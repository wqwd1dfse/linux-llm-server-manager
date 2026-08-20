import { Router } from 'express';
import { createForwardedConnection, executeCommand } from '../sshManager.js';
import { chmodPath, writeFile } from '../sftpManager.js';
import { getConfig, updateHfToken } from '../config.js';
import { validatePathWithinRoots, validatePort, validateSafePath } from '../executor.js';
import http from 'http';
import path from 'path';
import fs from 'fs';

const router = Router();

const DEFAULT_LLAMA_BIN = '/opt/llama.cpp/build/bin/llama-server';
const ALLOWED_CACHE_TYPES = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl']);
const ALLOWED_LLM_BIND_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0']);
const configuredBindHost = String(process.env.LLM_BIND_HOST || '127.0.0.1').trim();
const LLM_BIND_HOST = ALLOWED_LLM_BIND_HOSTS.has(configuredBindHost) ? configuredBindHost : '127.0.0.1';

if (LLM_BIND_HOST === '0.0.0.0') {
  console.warn('[LLM] LLM_BIND_HOST=0.0.0.0 exposes llama-server to the remote network; use a firewall and API authentication.');
}

// In-Memory Background Download Tasks Tracker
const downloadTasks = new Map();

// Active LLM Instance State Tracker
let activeInstance = {
  isRunning: false,
  source: 'file',
  port: 8080,
  pid: null,
  runtime: 'llama.cpp',
  modelPath: '',
  alias: '',
  context: 131072,
  launchParams: null,
  launchedAt: null
};

// Model Scanner Cache
let cachedLocalModels = null;
let lastModelScanTime = 0;
let isScanningModels = false;

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function validateModelLaunchParams(body) {
  const {
    modelPath,
    alias,
    ngl = 999,
    ctx = 131072,
    ctk = 'q8_0',
    ctv = 'q8_0',
    port = 8080,
    threads,
    parallel,
    fa = true
  } = body;

  const validPort = validatePort(port);

  const parsedNgl = Number.parseInt(ngl, 10);
  if (!Number.isInteger(parsedNgl) || parsedNgl < 0 || parsedNgl > 9999) {
    throw new Error('ngl 参数必须在 0 到 9999 之间');
  }

  const parsedCtx = Number.parseInt(ctx, 10);
  if (!Number.isInteger(parsedCtx) || parsedCtx < 512 || parsedCtx > 2097152) {
    throw new Error('ctx 上下文长度必须在 512 到 2097152 之间');
  }

  const cleanCtk = String(ctk).toLowerCase().trim();
  if (!ALLOWED_CACHE_TYPES.has(cleanCtk)) {
    throw new Error(`非法的 KV Cache Type (ctk): ${ctk}。允许: ${Array.from(ALLOWED_CACHE_TYPES).join(', ')}`);
  }

  const cleanCtv = String(ctv).toLowerCase().trim();
  if (!ALLOWED_CACHE_TYPES.has(cleanCtv)) {
    throw new Error(`非法的 KV Cache Type (ctv): ${ctv}。允许: ${Array.from(ALLOWED_CACHE_TYPES).join(', ')}`);
  }

  let cleanAlias = String(alias || 'custom-model').trim().replace(/[^\w\.\-]/g, '_');
  if (cleanAlias.length > 64) cleanAlias = cleanAlias.slice(0, 64);
  if (!cleanAlias) cleanAlias = 'llm-model';

  let cleanThreads = null;
  if (threads !== undefined && threads !== null && threads !== '') {
    const t = Number.parseInt(threads, 10);
    if (!Number.isInteger(t) || t < 1 || t > 256) throw new Error('threads 参数必须在 1 到 256 之间');
    cleanThreads = t;
  }

  let cleanParallel = null;
  if (parallel !== undefined && parallel !== null && parallel !== '') {
    const np = Number.parseInt(parallel, 10);
    if (!Number.isInteger(np) || np < 1 || np > 64) throw new Error('parallel 参数必须在 1 到 64 之间');
    cleanParallel = np;
  }

  return {
    port: validPort,
    ngl: parsedNgl,
    ctx: parsedCtx,
    ctk: cleanCtk,
    ctv: cleanCtv,
    alias: cleanAlias,
    threads: cleanThreads,
    parallel: cleanParallel,
    fa: Boolean(fa)
  };
}

function getModelRoots() {
  return getConfig().modelRoots || ['/mnt/models', '/opt/models'];
}

function validateModelFilePath(filePath) {
  return validatePathWithinRoots(
    filePath,
    [...getModelRoots(), '/root/.cache/huggingface']
  ).path;
}

function validateModelTargetDir(targetDir) {
  return validatePathWithinRoots(targetDir, getModelRoots()).path;
}

function validateHfDownloadUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(String(inputUrl));
  } catch (_) {
    throw new Error('Hugging Face 下载地址无效');
  }
  if (parsed.protocol !== 'https:' || !['huggingface.co', 'hf-mirror.com'].includes(parsed.hostname)) {
    throw new Error('下载地址仅允许使用 Hugging Face 或已配置镜像的 HTTPS 地址');
  }
  return parsed.toString();
}

function buildCurlTokenConfig(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return '';
  if (/[\r\n]/.test(cleanToken)) throw new Error('Hugging Face Token 格式无效');
  const escaped = `Authorization: Bearer ${cleanToken}`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `header = "${escaped}"\n`;
}

function buildLlamaArgs(source, modelPath, params) {
  const llamaArgs = source === 'hf'
    ? ['-hf', modelPath]
    : ['-m', modelPath];

  llamaArgs.push(
    '-ngl', String(params.ngl),
    '-c', String(params.ctx),
    '-ctk', params.ctk,
    '-ctv', params.ctv,
    '--no-mmap',
    '--jinja',
    '--host', LLM_BIND_HOST,
    '--port', String(params.port),
    '--alias', params.alias
  );

  if (params.fa) llamaArgs.push('-fa', 'on');
  if (params.threads) llamaArgs.push('-t', String(params.threads));
  if (params.parallel) llamaArgs.push('-np', String(params.parallel));
  return llamaArgs;
}

async function launchLlamaServer(source, modelPath, params) {
  const logFile = '/tmp/llama-server.log';
  const llamaArgs = buildLlamaArgs(source, modelPath, params);
  const launchScript = `nohup ${DEFAULT_LLAMA_BIN} "$@" > ${logFile} 2>&1 &`;
  return executeCommand('sh', ['-c', launchScript, 'sh', ...llamaArgs], { timeoutMs: 8000 });
}

// 1. Get LLM Server Status & Currently Loaded Model
router.get('/status', async (req, res) => {
  try {
    const procCheck = await executeCommand('sh', ['-c', 'ps aux | grep llama-server | grep -v grep | head -n 1'], { timeoutMs: 4000 });
    const isRunning = Boolean(procCheck.stdout && procCheck.stdout.trim().length > 0);

    let processInfo = null;
    let modelName = '未知 / 未运行';
    let port = activeInstance.port || 8080;
    let launchCmd = '';
    let pid = null;
    let modelDetails = null;

    if (isRunning) {
      const line = procCheck.stdout.trim();
      const parts = line.split(/\s+/);
      pid = parts[1];
      launchCmd = parts.slice(10).join(' ');

      const portMatch = launchCmd.match(/--port\s+(\d+)/) || launchCmd.match(/-p\s+(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }

      const aliasMatch = launchCmd.match(/--alias\s+([^\s]+)/);
      const hfMatch = launchCmd.match(/-hf\s+([^\s]+)/);
      const mMatch = launchCmd.match(/-m\s+([^\s]+)/);

      if (aliasMatch) modelName = aliasMatch[1];
      else if (hfMatch) modelName = hfMatch[1];
      else if (mMatch) modelName = mMatch[1].split('/').pop();

      activeInstance.isRunning = true;
      activeInstance.port = port;
      activeInstance.pid = pid;
      activeInstance.alias = modelName;

      processInfo = {
        pid,
        user: parts[0],
        cpu: parts[2],
        mem: parts[3],
        startTime: parts[8],
        launchCmd
      };
    } else {
      activeInstance.isRunning = false;
      activeInstance.pid = null;
    }

    let serverProps = null;
    let slots = null;
    let serverHealthy = false;

    if (isRunning) {
      try {
        const modelsRes = await executeCommand('curl', ['-s', `http://127.0.0.1:${port}/v1/models`], { timeoutMs: 3000 });
        if (modelsRes.stdout) {
          const modelsJson = JSON.parse(modelsRes.stdout);
          const firstModel = modelsJson.data?.[0] || modelsJson.models?.[0];
          if (firstModel) {
            modelName = firstModel.id || firstModel.name || modelName;
            const meta = firstModel.meta || {};
            const paramsCount = meta.n_params ? `${(meta.n_params / 1e9).toFixed(1)}B` : '';
            const ftype = meta.ftype || '';
            const sizeFormatted = meta.size ? formatBytes(meta.size) : '';

            modelDetails = {
              id: firstModel.id || modelName,
              params: paramsCount,
              quant: ftype,
              size: sizeFormatted,
              ctx: meta.n_ctx || 131072
            };

            if (paramsCount || ftype) {
              modelName = `${firstModel.id || modelName} (${[ftype, paramsCount].filter(Boolean).join(' / ')})`;
            }
          }
        }
      } catch (_) {}

      try {
        const propsRes = await executeCommand('curl', ['-s', `http://127.0.0.1:${port}/props`], { timeoutMs: 3000 });
        if (propsRes.stdout) {
          serverProps = JSON.parse(propsRes.stdout);
          serverHealthy = true;
        }
      } catch (_) {}

      try {
        const slotsRes = await executeCommand('curl', ['-s', `http://127.0.0.1:${port}/slots`], { timeoutMs: 3000 });
        if (slotsRes.stdout) {
          slots = JSON.parse(slotsRes.stdout);
        }
      } catch (_) {}
    }

    res.json({
      success: true,
      data: {
        isRunning,
        serverHealthy,
        modelName,
        modelDetails,
        port,
        processInfo,
        runtimeInfo: {
          source: activeInstance.source,
          context: activeInstance.launchParams?.ctx || activeInstance.context,
          ngl: activeInstance.launchParams?.ngl ?? null,
          cacheTypeK: activeInstance.launchParams?.ctk || null,
          cacheTypeV: activeInstance.launchParams?.ctv || null,
          threads: activeInstance.launchParams?.threads || null,
          parallel: activeInstance.launchParams?.parallel || null,
          flashAttention: activeInstance.launchParams?.fa ?? null,
          launchedAt: activeInstance.launchedAt,
          uptimeMs: activeInstance.launchedAt && isRunning ? Date.now() - activeInstance.launchedAt : null
        },
        serverProps,
        slots,
        hfTokenConfigured: Boolean(getConfig().hfToken)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Scan Local Models across Configured Model Roots
router.get('/local-models', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();

    if (!forceRefresh && cachedLocalModels && (now - lastModelScanTime < 15000)) {
      return res.json({ success: true, data: cachedLocalModels });
    }

    if (isScanningModels && cachedLocalModels) {
      return res.json({ success: true, data: cachedLocalModels });
    }

    isScanningModels = true;

    const dfRes = await executeCommand('sh', ['-c', "df -k /mnt/models 2>/dev/null | tail -n 1 | awk '{print $2,$3,$4,$5}'"], { timeoutMs: 4000 });
    let diskStats = { total: '--', used: '--', free: '--', percent: '0%' };
    if (dfRes.stdout) {
      const [tot, used, free, pct] = dfRes.stdout.trim().split(/\s+/);
      if (tot && used) {
        diskStats = {
          total: formatBytes(parseInt(tot, 10) * 1024),
          used: formatBytes(parseInt(used, 10) * 1024),
          free: formatBytes(parseInt(free, 10) * 1024),
          percent: pct || '0%'
        };
      }
    }

    const rootsJson = JSON.stringify(getConfig().modelRoots || ['/mnt/models', '/opt/models']);
    const maxDepth = parseInt(process.env.MODEL_SCAN_MAX_DEPTH, 10) || 4;

    const scanScript = `
import os, json, datetime

search_roots = ${rootsJson}
max_depth = ${maxDepth}
visited_realpaths = set()
models = []

for root in search_roots:
    if not os.path.exists(root):
        continue
    root_depth = root.rstrip('/').count('/')
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        cur_depth = dirpath.rstrip('/').count('/')
        if cur_depth - root_depth >= max_depth:
            del dirnames[:]
            continue
        if any(p in dirpath for p in ['/proc', '/sys', '/dev', '/run', '/tmp', '/var/cache']):
            del dirnames[:]
            continue
        for f in filenames:
            if f.endswith('.gguf') or (f.endswith('.bin') and not any(x in f for x in ['CMake', 'ompver', 'pkgcache', 'test'])):
                full_path = os.path.join(dirpath, f)
                try:
                    real_path = os.path.realpath(full_path)
                    if real_path in visited_realpaths:
                        continue
                    visited_realpaths.add(real_path)
                    st = os.stat(real_path)
                    size = st.st_size
                    if size < 20 * 1024 * 1024:
                        continue
                    dt_str = datetime.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
                    models.append({
                        'name': f,
                        'path': full_path,
                        'realPath': real_path,
                        'sizeBytes': size,
                        'modified': dt_str
                    })
                except Exception:
                    pass

print(json.dumps(models))
`;

    const scanResult = await executeCommand('python3', ['-c', scanScript], { timeoutMs: 15000 });
    let rawModels = [];
    try {
      rawModels = JSON.parse(scanResult.stdout.trim());
    } catch (_) {}

    const activeModelKeyword = activeInstance.alias || '';

    const models = rawModels.map(m => {
      const filename = m.name;
      const quantMatch = filename.match(/(IQ\d_[A-Z]+|Q\d_[A-Z0-9_]+|FP16|F16|Q\d_0|MXFP4)/i);
      const quant = quantMatch ? quantMatch[0].toUpperCase() : 'GGUF';

      const isActive = Boolean(
        activeModelKeyword &&
        (filename.toLowerCase().includes(activeModelKeyword.toLowerCase()) ||
         activeModelKeyword.toLowerCase().includes(filename.replace(/\.gguf$/i, '').toLowerCase()))
      );

      return {
        name: filename,
        path: m.path,
        realPath: m.realPath,
        sizeBytes: m.sizeBytes,
        sizeFormatted: formatBytes(m.sizeBytes),
        modified: m.modified,
        quant,
        isActive,
        isGguf: filename.endsWith('.gguf')
      };
    });

    models.sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      return b.sizeBytes - a.sizeBytes;
    });

    cachedLocalModels = {
      disk: diskStats,
      models,
      activeModel: activeModelKeyword
    };
    lastModelScanTime = now;
    isScanningModels = false;

    res.json({ success: true, data: cachedLocalModels });
  } catch (err) {
    isScanningModels = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a local model file
router.delete('/local-models', async (req, res) => {
  try {
    const filePath = validateModelFilePath(req.body.filePath);
    const delRes = await executeCommand('rm', ['-f', filePath], { timeoutMs: 5000 });
    if (!delRes.success) {
      return res.status(500).json({ success: false, error: delRes.stderr || '删除失败' });
    }

    cachedLocalModels = null;
    res.json({ success: true, message: `已成功删除模型文件: ${path.posix.basename(filePath)}` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Hugging Face Hub Online Model Explorer
router.get('/hf/search', async (req, res) => {
  try {
    const { q = '', filter = 'gguf', sort = 'downloads', limit = 30, mirror = false } = req.query;
    const baseApi = mirror === 'true' || mirror === true ? 'https://hf-mirror.com' : 'https://huggingface.co';

    let searchUrl = `${baseApi}/api/models?limit=${Math.min(parseInt(limit, 10) || 30, 50)}&full=false&direction=-1`;
    if (sort && sort !== 'trending') searchUrl += `&sort=${encodeURIComponent(sort)}`;
    if (filter) searchUrl += `&filter=${encodeURIComponent(filter)}`;
    if (q) searchUrl += `&search=${encodeURIComponent(q)}`;

    const hfRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Server-Manager-Dashboard/1.0' }
    });

    if (!hfRes.ok) {
      throw new Error(`HF API 响应失败 (${hfRes.status})`);
    }

    const list = await hfRes.json();

    const results = (list || []).map(m => {
      const id = m.id || '';
      const name = id.split('/').pop() || id;
      const author = m.author || id.split('/')[0] || 'Community';
      const paramMatch = name.match(/(\d+(\.\d+)?B|\d+x\d+B)/i);
      const paramScale = paramMatch ? paramMatch[0].toUpperCase() : '';

      return {
        id,
        author,
        name,
        paramScale,
        downloads: m.downloads || 0,
        likes: m.likes || 0,
        lastModified: m.lastModified,
        pipeline_tag: m.pipeline_tag || 'text-generation',
        tags: (m.tags || []).slice(0, 6),
        isGguf: (m.tags || []).includes('gguf') || id.toLowerCase().includes('gguf')
      };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get files in Hugging Face Repo
router.get('/hf/model-files', async (req, res) => {
  try {
    const { repo, mirror = false } = req.query;
    if (!repo || typeof repo !== 'string') return res.status(400).json({ success: false, error: '缺少 repo 参数' });

    const baseApi = mirror === 'true' || mirror === true ? 'https://hf-mirror.com' : 'https://huggingface.co';
    const treeUrl = `${baseApi}/api/models/${encodeURIComponent(repo)}/tree/main`;

    const treeRes = await fetch(treeUrl, {
      headers: { 'User-Agent': 'Server-Manager-Dashboard/1.0' }
    });

    if (!treeRes.ok) {
      throw new Error(`无法获取该模型的文件列表 (${treeRes.status})`);
    }

    const files = await treeRes.json();
    const ggufFiles = (files || [])
      .filter(f => f.type === 'file' && f.path.toLowerCase().endsWith('.gguf'))
      .map(f => {
        const sizeBytes = f.size || 0;
        const quantMatch = f.path.match(/(IQ\d_[A-Z]+|Q\d_[A-Z0-9_]+|FP16|F16|Q\d_0|MXFP4)/i);
        const quant = quantMatch ? quantMatch[0].toUpperCase() : 'GGUF';

        let qualityTag = '标准量化';
        let qualityColor = 'var(--win-accent)';
        if (quant.includes('Q4_K_M') || quant.includes('Q4_K_S')) {
          qualityTag = '🌟 黄金均衡推荐 (首选)';
          qualityColor = 'var(--perf-green)';
        } else if (quant.includes('Q8_0')) {
          qualityTag = '💎 接近无损 (高精度)';
          qualityColor = '#a855f7';
        } else if (quant.includes('Q5_K') || quant.includes('Q5_0')) {
          qualityTag = '✨ 高画质/高精度 (推荐)';
          qualityColor = '#0ea5e9';
        } else if (quant.includes('Q3_K') || quant.includes('IQ4') || quant.includes('IQ3') || quant.includes('Q2_K')) {
          qualityTag = '⚡ 极致显存压缩';
          qualityColor = 'var(--perf-yellow)';
        } else if (quant.includes('FP16') || quant.includes('F16')) {
          qualityTag = '📦 原始未量化浮点';
          qualityColor = 'var(--win-text-secondary)';
        }

        const vramGb = sizeBytes > 0 ? ((sizeBytes * 1.12) / 1024 / 1024 / 1024 + 1.2).toFixed(1) : '--';

        return {
          filename: f.path,
          sizeBytes,
          sizeFormatted: formatBytes(sizeBytes),
          quant,
          qualityTag,
          qualityColor,
          estimatedVram: `${vramGb} GB`,
          downloadUrl: `${baseApi}/${repo}/resolve/main/${f.path}`
        };
      });

    res.json({
      success: true,
      data: { repo, baseApi, files: ggufFiles }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Download Model without exposing tokens in process arguments
router.post('/hf/download', async (req, res) => {
  let tokenConfigToClean = '';
  try {
    const { repo, filename, downloadUrl, targetDir = '/mnt/models', hfToken } = req.body;
    if (!filename || !downloadUrl) {
      return res.status(400).json({ success: false, error: '缺少下载参数' });
    }

    const safeTargetDir = validateModelTargetDir(targetDir);
    const safeFilename = path.posix.basename(String(filename).replace(/\\/g, '/'));
    if (!safeFilename || !safeFilename.toLowerCase().endsWith('.gguf')) {
      throw new Error('仅允许下载 GGUF 模型文件');
    }
    const safeDownloadUrl = validateHfDownloadUrl(downloadUrl);
    const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const finalFile = path.posix.join(safeTargetDir, safeFilename);
    const partFile = `${finalFile}.part`;
    const logFile = `/tmp/download_${taskId}.log`;
    const tokenConfigPath = `/tmp/.server-manager-curl-${taskId}.conf`;

    await executeCommand('mkdir', ['-p', safeTargetDir]);
    if (hfToken && typeof hfToken === 'string' && hfToken.trim()) {
      updateHfToken(hfToken.trim());
    }

    const effectiveToken = (getConfig().hfToken || '').trim();
    const curlArgs = ['--fail', '--location', '--continue-at', '-', '--output', partFile, safeDownloadUrl];
    let activeTokenConfig = '';
    if (effectiveToken) {
      await writeFile(tokenConfigPath, buildCurlTokenConfig(effectiveToken));
      await chmodPath(tokenConfigPath, '600');
      curlArgs.unshift('--config', tokenConfigPath);
      activeTokenConfig = tokenConfigPath;
      tokenConfigToClean = tokenConfigPath;
    }

    const downloadScript = `
token_config="$1"
part_file="$2"
final_file="$3"
log_file="$4"
shift 4
nohup sh -c '
  token_config="$1"
  part_file="$2"
  final_file="$3"
  shift 3
  cleanup() { [ -n "$token_config" ] && rm -f -- "$token_config"; }
  trap cleanup EXIT HUP INT TERM
  curl "$@" && mv -- "$part_file" "$final_file"
' sh "$token_config" "$part_file" "$final_file" "$@" > "$log_file" 2>&1 < /dev/null &
echo $!
`.trim();

    const startRes = await executeCommand(
      'sh',
      ['-c', downloadScript, 'sh', activeTokenConfig, partFile, finalFile, logFile, ...curlArgs]
    );
    const pid = startRes.stdout ? startRes.stdout.trim() : '';
    if (!startRes.success || !/^\d+$/.test(pid)) {
      throw new Error(startRes.stderr || '无法启动模型下载任务');
    }

    const task = {
      id: taskId,
      repo: repo || safeFilename,
      filename: safeFilename,
      destFile: finalFile,
      partFile,
      downloadUrl: safeDownloadUrl,
      pid,
      logFile,
      tokenConfigPath: activeTokenConfig,
      status: 'downloading',
      totalBytes: parseInt(req.body.totalBytes, 10) || 0,
      downloadedBytes: 0,
      percent: 0,
      speedFormatted: '-- MB/s',
      etaFormatted: '--',
      startTime: Date.now(),
      lastBytes: 0,
      lastCheckTime: Date.now()
    };
    downloadTasks.set(taskId, task);
    tokenConfigToClean = '';

    res.json({
      success: true,
      taskId,
      message: `已开始下载 ${safeFilename} 到 ${finalFile}`
    });
  } catch (err) {
    if (tokenConfigToClean) {
      await executeCommand('rm', ['-f', tokenConfigToClean]).catch(() => {});
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// Download Task Status
router.get('/hf/tasks', async (req, res) => {
  try {
    const tasksList = [];

    for (const [id, task] of downloadTasks.entries()) {
      if (task.status === 'downloading') {
        const sizeRes = await executeCommand('sh', ['-c', `stat -c %s "${task.partFile}" 2>/dev/null || stat -c %s "${task.destFile}" 2>/dev/null || echo 0`], { timeoutMs: 2000 });
        const curBytes = parseInt(sizeRes.stdout.trim(), 10) || 0;
        task.downloadedBytes = curBytes;

        if (task.pid) {
          const procCheck = await executeCommand('sh', ['-c', `ps -p ${task.pid} >/dev/null 2>&1 && echo "running"`], { timeoutMs: 2000 });
          const isProcAlive = procCheck.stdout.includes('running');

          if (!isProcAlive) {
            const finalCheck = await executeCommand('test', ['-f', task.destFile], { timeoutMs: 2000 });
            if (finalCheck.success) {
              task.status = 'completed';
              task.percent = 100;
            } else {
              task.status = 'error';
            }
          }
        }

        if (task.totalBytes > 0 && task.status !== 'completed') {
          task.percent = Math.min(99, Math.round((curBytes / task.totalBytes) * 100));
        }

        const now = Date.now();
        const timeDelta = (now - task.lastCheckTime) / 1000;
        if (timeDelta >= 1) {
          const bytesDelta = curBytes - task.lastBytes;
          const bytesPerSec = bytesDelta / timeDelta;
          if (bytesPerSec > 0) {
            task.speedFormatted = `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
            if (task.totalBytes > curBytes) {
              const remainingSec = Math.round((task.totalBytes - curBytes) / bytesPerSec);
              const mins = Math.floor(remainingSec / 60);
              const secs = remainingSec % 60;
              task.etaFormatted = mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`;
            }
          }
          task.lastBytes = curBytes;
          task.lastCheckTime = now;
        }
      }

      tasksList.push({
        id: task.id,
        repo: task.repo,
        filename: task.filename,
        destFile: task.destFile,
        status: task.status,
        percent: task.percent,
        downloadedFormatted: formatBytes(task.downloadedBytes),
        totalFormatted: formatBytes(task.totalBytes),
        speed: task.speedFormatted,
        eta: task.etaFormatted
      });
    }

    res.json({ success: true, tasks: tasksList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cancel a download task
router.post('/hf/tasks/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const task = downloadTasks.get(id);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    if (task.pid) {
      await executeCommand('kill', ['-9', String(task.pid)]).catch(() => {});
    }

    if (task.tokenConfigPath) {
      await executeCommand('rm', ['-f', task.tokenConfigPath]).catch(() => {});
    }

    if (task.partFile) {
      await executeCommand('rm', ['-f', task.partFile]).catch(() => {});
    }

    task.status = 'canceled';
    downloadTasks.delete(id);

    res.json({ success: true, message: '任务已取消并清理临时文件' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Run a Local Model on llama-server (Strict Parameters Validation)
router.post('/run-local', async (req, res) => {
  try {
    const validatedParams = validateModelLaunchParams(req.body);
    const validatedPath = validateModelFilePath(req.body.filePath);

    await executeCommand('pkill', ['-9', '-f', 'llama-server']).catch(() => {});

    const runResult = await launchLlamaServer('file', validatedPath, validatedParams);

    if (!runResult.success) {
      return res.status(500).json({ success: false, error: runResult.stderr || '启动失败' });
    }

    activeInstance = {
      isRunning: true,
      source: 'file',
      port: validatedParams.port,
      pid: null,
      runtime: 'llama.cpp',
      modelPath: validatedPath,
      alias: validatedParams.alias,
      context: validatedParams.ctx,
      launchParams: validatedParams,
      launchedAt: Date.now()
    };

    res.json({
      success: true,
      message: `正在载入本地模型: ${validatedParams.alias} (端口: ${validatedParams.port})`,
      data: { modelAlias: validatedParams.alias, port: validatedParams.port }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Generic Start (File or HF Hub)
router.post('/start', async (req, res) => {
  try {
    const { source = 'file', modelPath } = req.body;
    if (!['file', 'hf'].includes(source)) throw new Error('模型来源仅支持 file 或 hf');
    const validatedParams = validateModelLaunchParams(req.body);

    await executeCommand('pkill', ['-9', '-f', 'llama-server']).catch(() => {});

    let validatedModelPath;
    if (source === 'hf') {
      if (!modelPath || typeof modelPath !== 'string') {
        throw new Error('HF Repo 格式不能为空');
      }
      validatedModelPath = modelPath.trim();
    } else {
      validatedModelPath = validateModelFilePath(modelPath);
    }

    const runResult = await launchLlamaServer(source, validatedModelPath, validatedParams);

    if (!runResult.success) {
      return res.status(500).json({ success: false, error: runResult.stderr || '启动失败' });
    }

    activeInstance = {
      isRunning: true,
      source,
      port: validatedParams.port,
      pid: null,
      runtime: 'llama.cpp',
      modelPath: validatedModelPath,
      alias: validatedParams.alias,
      context: validatedParams.ctx,
      launchParams: validatedParams,
      launchedAt: Date.now()
    };

    res.json({
      success: true,
      message: `大模型服务已发送启动指令 (模型: ${validatedParams.alias}, 端口: ${validatedParams.port})`,
      data: { alias: validatedParams.alias, port: validatedParams.port }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Stop llama-server
router.post('/stop', async (req, res) => {
  try {
    await executeCommand('pkill', ['-9', '-f', 'llama-server']).catch(() => {});
    activeInstance.isRunning = false;
    res.json({ success: true, message: '已停止 llama-server 推理服务' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restart llama-server
router.post('/restart', async (req, res) => {
  try {
    if (!activeInstance.modelPath || !activeInstance.launchParams) {
      return res.status(409).json({ success: false, error: '缺少上次启动参数，请重新选择模型启动' });
    }
    await executeCommand('pkill', ['-9', '-f', 'llama-server']).catch(() => {});

    const runResult = await launchLlamaServer(
      activeInstance.source || 'file',
      activeInstance.modelPath,
      activeInstance.launchParams
    );
    if (!runResult.success) {
      return res.status(500).json({ success: false, error: runResult.stderr || '重启失败' });
    }
    activeInstance.isRunning = true;
    activeInstance.launchedAt = Date.now();
    res.json({ success: true, message: '已按原参数重新启动推理模型服务' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get LLM Logs
router.get('/logs', async (req, res) => {
  try {
    const result = await executeCommand('tail', ['-n', '100', '/tmp/llama-server.log'], { timeoutMs: 4000 });
    res.json({ success: true, logs: result.stdout || '暂无运行日志' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE Streaming Chat Proxy through the authenticated SSH connection
router.post('/chat', async (req, res) => {
  let tunnel = null;
  try {
    const targetPort = activeInstance.port || 8080;
    const payload = JSON.stringify(req.body);
    tunnel = await createForwardedConnection('127.0.0.1', targetPort);

    const tunnelAgent = new http.Agent({ keepAlive: false });
    tunnelAgent.createConnection = () => tunnel;

    const options = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: '/v1/chat/completions',
      method: 'POST',
      agent: tunnelAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 120000
    };

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      if (!req.body.stream && proxyRes.headers['content-type']) {
        res.setHeader('Content-Type', proxyRes.headers['content-type']);
      }
      proxyRes.on('error', () => {
        try { tunnel?.destroy(); } catch (_) {}
      });
      proxyRes.on('end', () => {
        try { tunnel?.destroy(); } catch (_) {}
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('llama-server 请求超时'));
    });
    proxyReq.on('error', (err) => {
      try { tunnel?.destroy(); } catch (_) {}
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: `无法通过 SSH 连接 llama-server 端口 ${targetPort} (${err.message})` });
      } else {
        res.end();
      }
    });
    req.on('aborted', () => {
      proxyReq.destroy();
      try { tunnel?.destroy(); } catch (_) {}
    });

    proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    try { tunnel?.destroy(); } catch (_) {}
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

export default router;
