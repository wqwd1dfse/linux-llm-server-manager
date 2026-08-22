import { Router } from 'express';
import crypto from 'crypto';
import {
  assertSshTargetContext,
  captureSshTargetContext,
  createForwardedConnection,
  executeCommand,
  getConnectionStatus,
  runWithSshTargetContext
} from '../sshManager.js';
import { chmodPath, writeFile } from '../sftpManager.js';
import { getConfig, updateHfToken } from '../config.js';
import { validatePathWithinRoots, validatePort, validateSafePath } from '../executor.js';
import http from 'http';
import path from 'path';

const router = Router();

const DEFAULT_LLAMA_BIN = '/opt/llama.cpp/build/bin/llama-server';
const ALLOWED_CACHE_TYPES = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl']);
const ALLOWED_LLM_BIND_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0']);
const configuredBindHost = String(process.env.LLM_BIND_HOST || '127.0.0.1').trim();
const LLM_BIND_HOST = ALLOWED_LLM_BIND_HOSTS.has(configuredBindHost) ? configuredBindHost : '127.0.0.1';

if (LLM_BIND_HOST === '0.0.0.0') {
  console.warn('[LLM] LLM_BIND_HOST=0.0.0.0 exposes llama-server to the remote network; use a firewall and API authentication.');
}

const HF_FETCH_TIMEOUT_MS = 15_000;
const MAX_HF_README_BYTES = 1024 * 1024;
const MAX_HF_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_HF_TREE_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_HISTORY_PER_TARGET = 100;
export const MAX_TARGET_SCOPED_STATES = 32;
export function resolveMaxActiveModelDownloads(environment = process.env) {
  const text = String(environment.MAX_ACTIVE_MODEL_DOWNLOADS ?? '').trim();
  if (!/^\d+$/.test(text)) return 4;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 32 ? parsed : 4;
}
const MAX_ACTIVE_MODEL_DOWNLOADS = resolveMaxActiveModelDownloads();
const DOWNLOAD_TASK_RETENTION_MS = 60 * 60 * 1000;
const DOWNLOAD_REAPER_INTERVAL_MS = 1000;
const ACTIVE_DOWNLOAD_STATUSES = new Set(['starting', 'launching', 'canceling', 'downloading']);
const MANAGED_STATE_VERSION = 1;
const MAX_MANAGED_STATE_BYTES = 16 * 1024;
const MANAGED_STATE_FILE = 'state.json';
const MANAGED_IDENTITY_FILE = 'identity';
const DOWNLOAD_EXIT_STATUS_FILE = 'exit-status';
const DOWNLOAD_COMPLETION_FILE = 'completed';
const DOWNLOAD_EXIT_STATUS_TEMP_FILE = `${DOWNLOAD_EXIT_STATUS_FILE}.tmp`;
const DOWNLOAD_COMPLETION_TEMP_FILE = `${DOWNLOAD_COMPLETION_FILE}.tmp`;
const PRIVATE_RUNTIME_PATTERNS = Object.freeze({
  llama: /^\/tmp\/llm-manager-llama\.[A-Za-z0-9]{6,}$/,
  download: /^\/tmp\/llm-manager-download\.[A-Za-z0-9]{6,}$/
});

function configuredSshTarget(config = getConfig()) {
  const username = String(config.username || 'root');
  const host = String(config.host || '127.0.0.1');
  const port = Number(config.port || 22);
  return {
    key: JSON.stringify([username, host, port]),
    label: `${username}@${host}:${port}`
  };
}

/**
 * Resolve a stable key for target-scoped state. If configuration has already
 * changed while the old SSH client is still active, fail closed instead of
 * allowing a mutating request to run against an ambiguous host.
 */
export function resolveSshTargetIdentity(
  status = getConnectionStatus(),
  config = getConfig()
) {
  const target = configuredSshTarget(config);
  if (status?.connected && status.host && status.host !== target.label) {
    const error = new Error('SSH target is changing; retry after the new connection is ready');
    error.code = 'SSH_TARGET_CHANGING';
    throw error;
  }
  return target;
}

function requireCurrentTarget(expectedKey = null) {
  assertSshTargetContext();
  const target = resolveSshTargetIdentity();
  if (expectedKey && target.key !== expectedKey) {
    const error = new Error('SSH target changed while the operation was in progress');
    error.code = 'SSH_TARGET_CHANGED';
    throw error;
  }
  return target;
}

export class TargetScopedStore {
  constructor(factory, options = {}) {
    this.factory = factory;
    this.values = new Map();
    this.maxEntries = options.maxEntries || MAX_TARGET_SCOPED_STATES;
    this.canEvict = options.canEvict || (() => true);
  }

  makeRoom(targetKey) {
    if (this.values.has(targetKey)) return;
    while (this.values.size >= this.maxEntries) {
      const evictable = [...this.values.entries()].find(([key, value]) => this.canEvict(value, key));
      if (!evictable) {
        const error = new Error('Too many SSH targets have active LLM state; stop an existing task before adding another target');
        error.code = 'TARGET_STATE_CAPACITY';
        throw error;
      }
      this.values.delete(evictable[0]);
    }
  }

  touch(targetKey, value) {
    this.values.delete(targetKey);
    this.values.set(targetKey, value);
    return value;
  }

  get(targetKey) {
    if (!this.values.has(targetKey)) {
      this.makeRoom(targetKey);
      this.values.set(targetKey, this.factory(targetKey));
    }
    return this.touch(targetKey, this.values.get(targetKey));
  }

  peek(targetKey) {
    if (!this.values.has(targetKey)) return null;
    return this.touch(targetKey, this.values.get(targetKey));
  }

  set(targetKey, value) {
    this.makeRoom(targetKey);
    return this.touch(targetKey, value);
  }

  delete(targetKey) {
    return this.values.delete(targetKey);
  }

  entries() {
    return this.values.entries();
  }
}

export class TargetLifecycleMutex {
  constructor() {
    this.lockedTargets = new Set();
  }

  async run(targetKey, operation) {
    if (this.lockedTargets.has(targetKey)) {
      const error = new Error('该 SSH 服务器正在执行另一项模型生命周期操作，请稍后重试');
      error.code = 'LLM_LIFECYCLE_BUSY';
      throw error;
    }
    this.lockedTargets.add(targetKey);
    try {
      return await operation();
    } finally {
      this.lockedTargets.delete(targetKey);
    }
  }
}

export function runCoalescedTargetScan(state, operation) {
  if (state.scanPromise) return state.scanPromise;
  let scanPromise;
  scanPromise = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (state.scanPromise === scanPromise) state.scanPromise = null;
    });
  state.scanPromise = scanPromise;
  return scanPromise;
}

function validatePrivateRuntimeDirectory(runtimeDir, kind) {
  const normalized = validateSafePath(runtimeDir);
  const pattern = PRIVATE_RUNTIME_PATTERNS[kind];
  if (!pattern || !pattern.test(normalized)) throw new Error('Invalid private runtime directory');
  return normalized;
}

async function createPrivateRuntimeDirectory(kind) {
  const pattern = PRIVATE_RUNTIME_PATTERNS[kind];
  if (!pattern) throw new Error('Invalid private runtime kind');
  const result = await executeCommand('mktemp', ['-d', `/tmp/llm-manager-${kind}.XXXXXXXXXXXX`], { timeoutMs: 3000 });
  const runtimeDir = String(result.stdout || '').trim();
  if (!result.success || !pattern.test(runtimeDir)) {
    throw new Error(result.stderr || 'Unable to create a private runtime directory');
  }
  try {
    await chmodPath(runtimeDir, '700');
    const modeResult = await executeCommand('stat', ['-c', '%a', '--', runtimeDir], { timeoutMs: 2000 });
    if (!modeResult.success || modeResult.stdout.trim() !== '700') {
      throw new Error('Private runtime directory permissions could not be verified');
    }
    return runtimeDir;
  } catch (error) {
    try { await executeCommand('rmdir', ['--', runtimeDir], { timeoutMs: 2000 }); } catch (_) {}
    throw error;
  }
}

async function createPrivateRuntimeFile(runtimeDir, kind, filename, content = '') {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('Invalid private runtime filename');
  validatePrivateRuntimeDirectory(runtimeDir, kind);
  const filePath = path.posix.join(runtimeDir, filename);
  try {
    await writeFile(filePath, content, { mode: 0o600, exclusive: true });
    await chmodPath(filePath, '600');
    const modeResult = await executeCommand('stat', ['-c', '%a', '--', filePath], { timeoutMs: 2000 });
    if (!modeResult.success || modeResult.stdout.trim() !== '600') {
      throw new Error('Private runtime file permissions could not be verified');
    }
    return filePath;
  } catch (error) {
    try { await executeCommand('rm', ['-f', '--', filePath], { timeoutMs: 2000 }); } catch (_) {}
    throw error;
  }
}

async function cleanupPrivateRuntimeDirectory(runtimeDir, kind, files = []) {
  if (!runtimeDir) return;
  const safeRuntimeDir = validatePrivateRuntimeDirectory(runtimeDir, kind);
  const verifyResult = await executeCommand(
    'sh',
    [
      '-c',
      'runtime_dir="$1"; uid=$(id -u) || exit 1; [ -d "$runtime_dir" ] && [ ! -L "$runtime_dir" ] && [ "$(stat -c \'%u\' -- "$runtime_dir" 2>/dev/null)" = "$uid" ] && [ "$(stat -c \'%a\' -- "$runtime_dir" 2>/dev/null)" = 700 ]',
      'sh', safeRuntimeDir
    ],
    { timeoutMs: 2000 }
  );
  if (!verifyResult.success) throw new Error('Private runtime directory ownership or permissions could not be verified');
  for (const filePath of new Set(files.filter(Boolean))) {
    const normalized = validateSafePath(filePath);
    if (path.posix.dirname(normalized) !== safeRuntimeDir) {
      throw new Error('Refusing to clean a file outside its private runtime directory');
    }
    const removeResult = await executeCommand('rm', ['-f', '--', normalized], { timeoutMs: 2000 });
    if (!removeResult.success) throw new Error(removeResult.stderr || 'Unable to clean private runtime file');
  }
  const removeDirResult = await executeCommand('rmdir', ['--', safeRuntimeDir], { timeoutMs: 2000 });
  if (!removeDirResult.success) throw new Error(removeDirResult.stderr || 'Unable to clean private runtime directory');
}

export function attachConnectedSocketToAgent(agent, socket) {
  agent.createConnection = (_options, callback) => {
    queueMicrotask(() => {
      if (socket?.destroyed) {
        callback(new Error('SSH 端口转发连接已关闭'));
      } else {
        callback(null, socket);
      }
    });
  };
  return agent;
}

function parseBoundedInteger(value, name, min, max, fallback = null) {
  if ((value === undefined || value === null || value === '') && fallback !== null) return fallback;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${name} 参数必须为整数`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 参数必须在 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

function parseBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  throw new Error(`${name} 参数必须为布尔值`);
}

async function fetchFromHuggingFace(url) {
  try {
    return await fetch(url, {
      headers: { 'User-Agent': 'Linux-LLM-Server-Manager/1.0' },
      signal: AbortSignal.timeout(HF_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      const timeoutError = new Error('Hugging Face API 请求超时');
      timeoutError.code = 'HF_FETCH_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  }
}

function validateHfRepoId(value) {
  const repo = String(value || '').trim();
  if (repo.length > 200 || !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) {
    const error = new Error('Hugging Face Repo 必须为 owner/model 格式');
    error.code = 'HF_REPO_INVALID';
    throw error;
  }
  return repo;
}

export function validateHfAccessToken(value, allowEmpty = false) {
  if (typeof value !== 'string') {
    const error = new Error('Hugging Face Token 必须为字符串');
    error.code = 'HF_TOKEN_INVALID';
    throw error;
  }
  const token = value.trim();
  if (!token && allowEmpty) return '';
  if (!token || Buffer.byteLength(token, 'utf8') > 512 || !/^hf_[A-Za-z0-9._-]+$/.test(token)) {
    const error = new Error('Hugging Face Token 格式无效');
    error.code = 'HF_TOKEN_INVALID';
    throw error;
  }
  return token;
}

function createDefaultActiveInstance(targetIdentity) {
  return {
    targetIdentity,
    isRunning: false,
    source: 'file',
    port: 8080,
    pid: null,
    pidStartTime: null,
    ownershipToken: null,
    runtimeDir: null,
    statePath: null,
    identityPath: null,
    logPath: null,
    runtime: 'llama.cpp',
    modelPath: '',
    alias: '',
    context: 131072,
    launchParams: null,
    launchedAt: null,
    launchAmbiguous: false
  };
}

export async function readBoundedResponseText(
  response,
  maxBytes = MAX_HF_README_BYTES,
  label = 'README',
  errorCode = 'HF_README_TOO_LARGE'
) {
  const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch (_) {}
    const error = new Error(`${label} 超过 ${formatBytes(maxBytes)} 限制`);
    error.code = errorCode;
    throw error;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = new Error(`${label} 超过 ${formatBytes(maxBytes)} 限制`);
        error.code = errorCode;
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch (_) {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

// Every remote process, download and cache belongs to exactly one SSH target.
const downloadTasksByTarget = new TargetScopedStore(() => new Map(), {
  canEvict: (tasks) => ![...tasks.values()].some((task) => ACTIVE_DOWNLOAD_STATUSES.has(task.status))
});
const activeInstancesByTarget = new TargetScopedStore(createDefaultActiveInstance, {
  canEvict: (instance) => !instance?.pid && !instance?.isRunning && !instance?.launchAmbiguous
});
const localModelStateByTarget = new TargetScopedStore(() => ({
  cached: null,
  lastScanTime: 0,
  scanPromise: null
}), { canEvict: (state) => !state?.scanPromise });
const managedStateRecoveryByTarget = new TargetScopedStore(() => ({
  complete: false,
  promise: null
}), { canEvict: (state) => !state?.promise });
const llmLifecycleMutex = new TargetLifecycleMutex();

function pruneDownloadTasks(now = Date.now()) {
  for (const [targetKey, downloadTasks] of downloadTasksByTarget.entries()) {
    for (const [id, task] of downloadTasks.entries()) {
      if (!ACTIVE_DOWNLOAD_STATUSES.has(task.status) && now - (task.finishedAt || task.startTime) > DOWNLOAD_TASK_RETENTION_MS) {
        downloadTasks.delete(id);
      }
    }
    while (downloadTasks.size > MAX_DOWNLOAD_HISTORY_PER_TARGET) {
      const removable = [...downloadTasks.entries()].find(([, task]) => !ACTIVE_DOWNLOAD_STATUSES.has(task.status));
      if (!removable) break;
      downloadTasks.delete(removable[0]);
    }
    if (downloadTasks.size === 0) downloadTasksByTarget.delete(targetKey);
  }
}

function findDownloadTask(taskId) {
  for (const [targetKey, tasks] of downloadTasksByTarget.entries()) {
    const task = tasks.get(taskId);
    if (task) return { targetKey, task };
  }
  return null;
}

function formatBytes(bytes) {
  const numericBytes = Number(bytes);
  if (!Number.isFinite(numericBytes) || numericBytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(numericBytes) / Math.log(k)));
  return `${Number.parseFloat((numericBytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function normalizeHfNonNegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
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

  const parsedNgl = parseBoundedInteger(ngl, 'ngl', 0, 9999);
  const parsedCtx = parseBoundedInteger(ctx, 'ctx', 512, 2097152);

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

  const cleanThreads = threads === undefined || threads === null || threads === ''
    ? null : parseBoundedInteger(threads, 'threads', 1, 256);
  const cleanParallel = parallel === undefined || parallel === null || parallel === ''
    ? null : parseBoundedInteger(parallel, 'parallel', 1, 64);

  return {
    port: validPort,
    ngl: parsedNgl,
    ctx: parsedCtx,
    ctk: cleanCtk,
    ctv: cleanCtv,
    alias: cleanAlias,
    threads: cleanThreads,
    parallel: cleanParallel,
    fa: parseBoolean(fa, 'fa', true)
  };
}

function getModelRoots() {
  return getConfig().modelRoots || ['/mnt/models', '/opt/models'];
}

function validateModelFilePath(filePath) {
  const normalized = validatePathWithinRoots(
    filePath,
    [...getModelRoots(), '/root/.cache/huggingface']
  ).path;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('模型路径包含非法控制字符');
  return normalized;
}

function validateModelTargetDir(targetDir) {
  const normalized = validatePathWithinRoots(targetDir, getModelRoots()).path;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('模型目标目录包含非法控制字符');
  return normalized;
}

function validateModelDownloadPath(filePath) {
  const normalized = validatePathWithinRoots(filePath, getModelRoots()).path;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('模型下载路径包含非法控制字符');
  return normalized;
}

function validateHfDownloadUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(String(inputUrl));
  } catch (_) {
    throw new Error('Hugging Face 下载地址无效');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !['huggingface.co', 'hf-mirror.com'].includes(parsed.hostname)
  ) {
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

function managedRuntimeFilePath(runtimeDir, kind, filename) {
  const safeRuntimeDir = validatePrivateRuntimeDirectory(runtimeDir, kind);
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('Invalid managed runtime filename');
  return path.posix.join(safeRuntimeDir, filename);
}

function serializeManagedState(record) {
  const serialized = JSON.stringify(record);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_MANAGED_STATE_BYTES) {
    throw new Error('Managed process state is too large to persist safely');
  }
  return serialized;
}

function validateOwnershipToken(value) {
  const token = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error('Managed process ownership token is invalid');
  }
  return token;
}

function parseManagedIdentity(value) {
  const match = String(value || '').trim().match(/^(\d+)\s+(\d+)$/);
  if (!match || match[1] === '0' || match[2] === '0') {
    throw new Error('Managed process identity is invalid');
  }
  return { pid: match[1], pidStartTime: match[2] };
}

function parseManagedStateJson(rawState, kind, targetIdentity, runtimeDir) {
  const text = String(rawState || '');
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_MANAGED_STATE_BYTES) {
    throw new Error('Managed process state is empty or oversized');
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (_) {
    throw new Error('Managed process state is not valid JSON');
  }
  if (!record || Array.isArray(record) || typeof record !== 'object') {
    throw new Error('Managed process state must be an object');
  }
  if (
    record.version !== MANAGED_STATE_VERSION
    || record.kind !== kind
    || record.targetIdentity !== targetIdentity
    || record.runtimeDir !== runtimeDir
  ) {
    throw new Error('Managed process state does not belong to this SSH target and runtime directory');
  }
  validateOwnershipToken(record.ownershipToken);
  return record;
}

export function parseRecoveredLlamaState(rawState, rawIdentity, targetIdentity, runtimeDir) {
  const safeRuntimeDir = validatePrivateRuntimeDirectory(runtimeDir, 'llama');
  const record = parseManagedStateJson(rawState, 'llama', targetIdentity, safeRuntimeDir);
  const identity = parseManagedIdentity(rawIdentity);
  if (!['file', 'hf'].includes(record.source)) throw new Error('Recovered llama source is invalid');
  const modelPath = record.source === 'hf'
    ? validateHfRepoId(record.modelPath)
    : validateModelFilePath(record.modelPath);
  if (!record.launchParams || Array.isArray(record.launchParams) || typeof record.launchParams !== 'object') {
    throw new Error('Recovered llama launch parameters are missing');
  }
  const requiredLaunchFields = ['port', 'ngl', 'ctx', 'ctk', 'ctv', 'alias', 'threads', 'parallel', 'fa'];
  if (requiredLaunchFields.some((field) => !Object.prototype.hasOwnProperty.call(record.launchParams, field))) {
    throw new Error('Recovered llama launch parameters are incomplete');
  }
  const launchParams = validateModelLaunchParams(record.launchParams);
  if (requiredLaunchFields.some((field) => launchParams[field] !== record.launchParams[field])) {
    throw new Error('Recovered llama launch parameters are not canonical');
  }
  const launchedAt = Number(record.launchedAt);
  if (!Number.isSafeInteger(launchedAt) || launchedAt <= 0) throw new Error('Recovered llama launch time is invalid');
  return {
    targetIdentity,
    isRunning: false,
    source: record.source,
    port: launchParams.port,
    pid: identity.pid,
    pidStartTime: identity.pidStartTime,
    ownershipToken: validateOwnershipToken(record.ownershipToken),
    runtimeDir: safeRuntimeDir,
    statePath: managedRuntimeFilePath(safeRuntimeDir, 'llama', MANAGED_STATE_FILE),
    identityPath: managedRuntimeFilePath(safeRuntimeDir, 'llama', MANAGED_IDENTITY_FILE),
    logPath: managedRuntimeFilePath(safeRuntimeDir, 'llama', 'llama-server.log'),
    runtime: 'llama.cpp',
    modelPath,
    alias: launchParams.alias,
    context: launchParams.ctx,
    launchParams,
    launchedAt
  };
}

export const LIST_MANAGED_RUNTIME_DIRS_SCRIPT = `
kind="$1"
case "$kind" in
  llama|download) ;;
  *) exit 2 ;;
esac
uid=$(id -u) || exit 1
find /tmp -mindepth 1 -maxdepth 1 -type d -user "$uid" -perm 0700 \
  -name "llm-manager-$kind.*" -print 2>/dev/null
`.trim();

export const READ_MANAGED_RUNTIME_STATE_SCRIPT = `
runtime_dir="$1"
kind="$2"
case "$kind:$runtime_dir" in
  llama:/tmp/llm-manager-llama.[A-Za-z0-9]*) ;;
  download:/tmp/llm-manager-download.[A-Za-z0-9]*) ;;
  *) exit 2 ;;
esac
state_file="$runtime_dir/${MANAGED_STATE_FILE}"
identity_file="$runtime_dir/${MANAGED_IDENTITY_FILE}"
case "$kind" in
  llama) required_files="$state_file $identity_file $runtime_dir/llama-server.log" ;;
  download) required_files="$state_file $identity_file $runtime_dir/download.log" ;;
esac
uid=$(id -u) || exit 1
[ -d "$runtime_dir" ] && [ ! -L "$runtime_dir" ] || exit 3
[ "$(stat -c '%u' -- "$runtime_dir" 2>/dev/null)" = "$uid" ] || exit 3
[ "$(stat -c '%a' -- "$runtime_dir" 2>/dev/null)" = 700 ] || exit 3
for managed_file in $required_files; do
  [ -f "$managed_file" ] && [ ! -L "$managed_file" ] || exit 4
  [ "$(stat -c '%u' -- "$managed_file" 2>/dev/null)" = "$uid" ] || exit 4
  [ "$(stat -c '%a' -- "$managed_file" 2>/dev/null)" = 600 ] || exit 4
done
state_size=$(stat -c '%s' -- "$state_file" 2>/dev/null) || exit 4
identity_size=$(stat -c '%s' -- "$identity_file" 2>/dev/null) || exit 4
case "$state_size:$identity_size" in *[!0-9:]*|'') exit 4 ;; esac
[ "$state_size" -gt 0 ] && [ "$state_size" -le ${MAX_MANAGED_STATE_BYTES} ] || exit 4
[ "$identity_size" -gt 0 ] && [ "$identity_size" -le 128 ] || exit 4
printf 'STATE:'
cat -- "$state_file" || exit 4
printf '\nIDENTITY:'
cat -- "$identity_file" || exit 4
`.trim();

async function readManagedRuntimeStates(kind, target, parser) {
  requireCurrentTarget(target.key);
  const listResult = await executeCommand(
    'sh',
    ['-c', LIST_MANAGED_RUNTIME_DIRS_SCRIPT, 'sh', kind],
    { timeoutMs: 4000 }
  );
  if (!listResult.success) throw new Error(listResult.stderr || 'Unable to enumerate managed runtime state');
  requireCurrentTarget(target.key);
  const pattern = PRIVATE_RUNTIME_PATTERNS[kind];
  const candidates = [...new Set(String(listResult.stdout || '').split(/\r?\n/).filter((item) => pattern.test(item)))].slice(0, 128);
  const recovered = [];
  for (const runtimeDir of candidates) {
    try {
      recovered.push(await readManagedRuntimeStateAtPath(kind, target.key, runtimeDir, parser));
    } catch (error) {
      if (error?.code === 'SSH_TARGET_CHANGED' || error?.code === 'SSH_TARGET_CHANGING') throw error;
      console.warn(`[LLM] Ignoring invalid ${kind} runtime state ${runtimeDir}:`, error.message);
    }
  }
  requireCurrentTarget(target.key);
  return recovered;
}

async function readManagedRuntimeStateAtPath(kind, targetIdentity, runtimeDir, parser) {
  validatePrivateRuntimeDirectory(runtimeDir, kind);
  requireCurrentTarget(targetIdentity);
  const result = await executeCommand(
    'sh',
    ['-c', READ_MANAGED_RUNTIME_STATE_SCRIPT, 'sh', runtimeDir, kind],
    { timeoutMs: 3000 }
  );
  requireCurrentTarget(targetIdentity);
  if (!result.success) {
    const error = new Error(result.stderr || `Managed ${kind} runtime state is not ready`);
    error.code = 'MANAGED_STATE_NOT_READY';
    error.commandResult = result;
    throw error;
  }
  const match = String(result.stdout || '').match(/^STATE:(.*)\r?\nIDENTITY:(.*)\s*$/s);
  if (!match) {
    const error = new Error(`Managed ${kind} runtime state response is malformed`);
    error.code = 'MANAGED_STATE_NOT_READY';
    throw error;
  }
  return parser(match[1], match[2], targetIdentity, runtimeDir);
}

async function launchLlamaServer(source, modelPath, params, targetIdentity) {
  const llamaArgs = buildLlamaArgs(source, modelPath, params);
  const ownershipToken = crypto.randomUUID();
  const runtimeDir = await createPrivateRuntimeDirectory('llama');
  let logPath = '';
  let statePath = '';
  let identityPath = '';
  let keepRuntime = false;
  const launchScript = `
manager_token="$1"
log_file="$2"
identity_file="$3"
shift 3
LLM_MANAGER_PROCESS_TOKEN="$manager_token" nohup ${DEFAULT_LLAMA_BIN} "$@" > "$log_file" 2>&1 < /dev/null &
pid=$!
start_time=""
attempt=0
while [ "$attempt" -lt 20 ]; do
  start_time=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
  [ -n "$start_time" ] && break
  attempt=$((attempt + 1))
  sleep 0.02
done
if ! printf '%s' "$pid" | grep -Eq '^[0-9]+$' || ! printf '%s' "$start_time" | grep -Eq '^[0-9]+$'; then
  kill -TERM "$pid" 2>/dev/null || true
  echo "Unable to capture managed llama-server process identity" >&2
  exit 1
fi
if ! (umask 077 && printf '%s %s\n' "$pid" "$start_time" > "$identity_file"); then
  kill -TERM "$pid" 2>/dev/null || true
  echo "Unable to persist managed llama-server process identity" >&2
  exit 1
fi
printf '%s %s\n' "$pid" "$start_time"
`.trim();
  try {
    logPath = await createPrivateRuntimeFile(runtimeDir, 'llama', 'llama-server.log');
    statePath = await createPrivateRuntimeFile(
      runtimeDir,
      'llama',
      MANAGED_STATE_FILE,
      serializeManagedState({
        version: MANAGED_STATE_VERSION,
        kind: 'llama',
        targetIdentity,
        ownershipToken,
        runtimeDir,
        source,
        modelPath,
        launchParams: params,
        launchedAt: Date.now()
      })
    );
    identityPath = await createPrivateRuntimeFile(runtimeDir, 'llama', MANAGED_IDENTITY_FILE);
    const result = await executeCommand(
      'sh',
      ['-c', launchScript, 'sh', ownershipToken, logPath, identityPath, ...llamaArgs],
      { timeoutMs: 8000 }
    );
    const identityLine = result.stdout.trim().split('\n').at(-1) || '';
    const responseIdentityMatch = identityLine.match(/^(\d+)\s+(\d+)$/);
    let identityMatch = result.success ? responseIdentityMatch : null;
    let recoveredAfterAmbiguousResponse = false;
    let stateReadError = null;
    if (!result.success || !identityMatch) {
      try {
        const recovered = await readManagedRuntimeStateAtPath(
          'llama',
          targetIdentity,
          runtimeDir,
          parseRecoveredLlamaState
        );
        const recoveredStatus = await inspectManagedLlamaProcess(recovered, targetIdentity);
        if (recoveredStatus === 'running') {
          identityMatch = [null, recovered.pid, recovered.pidStartTime];
          recoveredAfterAmbiguousResponse = true;
        }
      } catch (error) {
        stateReadError = error;
      }
    }
    if (!identityMatch) {
      const ambiguous = Boolean(
        result.success
        || result.timeout
        || result.aborted
        || result.code === -1
        || ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING'].includes(stateReadError?.code)
      );
      if (ambiguous) {
        keepRuntime = true;
        return {
          ...result,
          success: false,
          ambiguous: true,
          stderr: result.stderr || stateReadError?.message || 'llama-server 启动结果未知，已保留安全恢复状态',
          ownershipToken,
          runtimeDir,
          statePath,
          identityPath,
          logPath
        };
      }
      return { ...result, success: false, stderr: result.stderr || 'llama-server 启动后未返回有效 PID' };
    }
    keepRuntime = true;
    return {
      ...result,
      success: result.success || recoveredAfterAmbiguousResponse,
      recoveredAfterAmbiguousResponse,
      pid: identityMatch?.[1] || '',
      pidStartTime: identityMatch?.[2] || '',
      ownershipToken,
      runtimeDir,
      statePath,
      identityPath,
      logPath
    };
  } finally {
    if (!keepRuntime) {
      try {
        await cleanupPrivateRuntimeDirectory(runtimeDir, 'llama', [logPath, statePath, identityPath]);
      } catch (_) {}
    }
  }
}

function preserveAmbiguousLlamaLaunch(targetIdentity, source, modelPath, params, runResult) {
  activeInstancesByTarget.set(targetIdentity, {
    targetIdentity,
    isRunning: false,
    source,
    port: params.port,
    pid: null,
    pidStartTime: null,
    ownershipToken: runResult.ownershipToken,
    runtimeDir: runResult.runtimeDir,
    statePath: runResult.statePath,
    identityPath: runResult.identityPath,
    logPath: runResult.logPath,
    runtime: 'llama.cpp',
    modelPath,
    alias: params.alias,
    context: params.ctx,
    launchParams: params,
    launchedAt: Date.now(),
    launchAmbiguous: true
  });
  const recovery = managedStateRecoveryByTarget.get(targetIdentity);
  recovery.complete = false;
}

const TERMINATE_MANAGED_LLAMA_SCRIPT = `
pid="$1"
expected_bin="$2"
expected_start="$3"
expected_token="$4"

if ! printf '%s' "$pid" | grep -Eq '^[0-9]+$' || ! printf '%s' "$expected_start" | grep -Eq '^[0-9]+$' || [ -z "$expected_token" ]; then
  echo "STATUS:IDENTITY_MISMATCH"
  exit 42
fi
if ! kill -0 "$pid" 2>/dev/null; then
  echo "STATUS:NOT_RUNNING"
  exit 0
fi

expected_exe=$(readlink -f "$expected_bin" 2>/dev/null || printf '%s' "$expected_bin")
identity_matches() {
  actual_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
  actual_exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
  [ "$actual_start" = "$expected_start" ] &&
    [ -n "$actual_exe" ] &&
    [ "$actual_exe" = "$expected_exe" ] &&
    tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null |
      grep -Fqx -- "LLM_MANAGER_PROCESS_TOKEN=$expected_token"
}
if ! identity_matches; then
  echo "STATUS:IDENTITY_MISMATCH"
  exit 42
fi

kill -TERM "$pid" 2>/dev/null || true
count=0
while kill -0 "$pid" 2>/dev/null && identity_matches && [ "$count" -lt 20 ]; do
  sleep 0.1
  count=$((count + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  if identity_matches; then
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.1
  else
    echo "STATUS:STOPPED"
    exit 0
  fi
fi
if kill -0 "$pid" 2>/dev/null && identity_matches; then
  echo "STATUS:STOP_FAILED"
  exit 43
fi
echo "STATUS:STOPPED"
`.trim();

export async function terminateManagedLlamaProcess(
  instance,
  currentTargetIdentity,
  executor = executeCommand
) {
  if (!instance?.pid) return { stopped: false, reason: 'not-managed' };
  if (!currentTargetIdentity || instance.targetIdentity !== currentTargetIdentity) {
    return { stopped: false, reason: 'target-mismatch' };
  }
  if (!instance.pidStartTime || !instance.ownershipToken) {
    const error = new Error('Managed llama-server process identity is incomplete; refusing to signal it');
    error.code = 'MANAGED_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }

  const result = await executor(
    'sh',
    [
      '-c', TERMINATE_MANAGED_LLAMA_SCRIPT, 'sh',
      String(instance.pid), DEFAULT_LLAMA_BIN, String(instance.pidStartTime), String(instance.ownershipToken)
    ],
    { timeoutMs: 5000 }
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (output.includes('STATUS:IDENTITY_MISMATCH')) {
    const error = new Error('Refusing to terminate a PID that no longer belongs to the managed llama-server');
    error.code = 'MANAGED_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }
  if (!result.success || output.includes('STATUS:STOP_FAILED')) {
    throw new Error(result.stderr || 'Unable to stop the managed llama-server process');
  }
  return {
    stopped: output.includes('STATUS:STOPPED'),
    reason: output.includes('STATUS:NOT_RUNNING') ? 'not-running' : 'stopped'
  };
}

async function cleanupManagedLlamaRuntime(instance) {
  if (!instance?.runtimeDir) return;
  await cleanupPrivateRuntimeDirectory(
    instance.runtimeDir,
    'llama',
    [instance.logPath, instance.statePath, instance.identityPath]
  );
  instance.runtimeDir = null;
  instance.logPath = null;
  instance.statePath = null;
  instance.identityPath = null;
}

async function stopManagedLlamaServer(target = requireCurrentTarget()) {
  const activeInstance = activeInstancesByTarget.peek(target.key);
  if (!activeInstance?.pid) {
    if (activeInstance?.launchAmbiguous) {
      const recovery = managedStateRecoveryByTarget.get(target.key);
      recovery.complete = false;
      const error = new Error('llama-server 启动结果仍不确定；已保留身份状态，稍后重试以安全恢复或停止');
      error.code = 'MANAGED_PROCESS_LAUNCH_AMBIGUOUS';
      throw error;
    }
    if (activeInstance?.runtimeDir) {
      await cleanupManagedLlamaRuntime(activeInstance);
      activeInstance.ownershipToken = null;
      activeInstance.pidStartTime = null;
    }
    requireCurrentTarget(target.key);
    return { stopped: false, reason: 'not-managed' };
  }

  requireCurrentTarget(target.key);
  const result = await terminateManagedLlamaProcess(activeInstance, target.key);
  try {
    await cleanupManagedLlamaRuntime(activeInstance);
  } catch (error) {
    console.warn('[LLM] Failed to clean private llama runtime directory:', error.message);
  }
  activeInstance.isRunning = false;
  activeInstance.pid = null;
  activeInstance.pidStartTime = null;
  activeInstance.ownershipToken = null;
  requireCurrentTarget(target.key);
  return result;
}

const INSPECT_MANAGED_LLAMA_SCRIPT = `
pid="$1"
expected_bin="$2"
expected_start="$3"
expected_token="$4"
if ! printf '%s' "$pid" | grep -Eq '^[0-9]+$' || ! printf '%s' "$expected_start" | grep -Eq '^[0-9]+$' || [ -z "$expected_token" ]; then
  echo "STATUS:IDENTITY_MISMATCH"
  exit 0
fi
if ! kill -0 "$pid" 2>/dev/null; then
  echo "STATUS:NOT_RUNNING"
  exit 0
fi
actual_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
actual_exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
expected_exe=$(readlink -f "$expected_bin" 2>/dev/null || printf '%s' "$expected_bin")
if [ "$actual_start" != "$expected_start" ] || [ -z "$actual_exe" ] || [ "$actual_exe" != "$expected_exe" ] ||
   ! tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx -- "LLM_MANAGER_PROCESS_TOKEN=$expected_token"; then
  echo "STATUS:IDENTITY_MISMATCH"
else
  echo "STATUS:RUNNING"
fi
`.trim();

async function inspectManagedLlamaProcess(instance, targetIdentity) {
  if (!instance?.pid || instance.targetIdentity !== targetIdentity) return 'not-managed';
  const result = await executeCommand(
    'sh',
    [
      '-c', INSPECT_MANAGED_LLAMA_SCRIPT, 'sh',
      String(instance.pid), DEFAULT_LLAMA_BIN, String(instance.pidStartTime || ''), String(instance.ownershipToken || '')
    ],
    { timeoutMs: 3000 }
  );
  if (!result.success && !result.stdout) throw new Error(result.stderr || 'Unable to inspect managed llama-server');
  if (result.stdout.includes('STATUS:RUNNING')) return 'running';
  if (result.stdout.includes('STATUS:IDENTITY_MISMATCH')) return 'identity-mismatch';
  return 'not-running';
}

// 1. Get LLM Server Status & Currently Loaded Model
router.get('/status', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    const activeInstance = activeInstancesByTarget.get(target.key);
    const managedProcessStatus = await inspectManagedLlamaProcess(activeInstance, target.key);
    requireCurrentTarget(target.key);
    const isRunning = managedProcessStatus === 'running';

    let processInfo = null;
    let modelName = activeInstance.alias || '未知 / 未运行';
    let port = activeInstance.port || 8080;
    let launchCmd = '';
    let pid = activeInstance.pid || null;
    let modelDetails = null;

    if (isRunning) {
      activeInstance.isRunning = true;
      launchCmd = activeInstance.launchParams
        ? [DEFAULT_LLAMA_BIN, ...buildLlamaArgs(activeInstance.source, activeInstance.modelPath, activeInstance.launchParams)].join(' ')
        : DEFAULT_LLAMA_BIN;

      processInfo = {
        pid,
        launchCmd,
        managed: true,
        target: target.label
      };
    } else {
      activeInstance.isRunning = false;
      if (managedProcessStatus === 'not-running') {
        try {
          await cleanupManagedLlamaRuntime(activeInstance);
        } catch (error) {
          console.warn('[LLM] Failed to clean stopped llama runtime state:', error.message);
        }
        activeInstance.pid = null;
        activeInstance.pidStartTime = null;
        activeInstance.ownershipToken = null;
        pid = null;
      }
    }

    let serverProps = null;
    let slots = null;
    let serverHealthy = false;

    if (isRunning) {
      const safeProbe = (probe) => probe.catch((error) => {
        if (error?.code === 'SSH_TARGET_CHANGED' || error?.code === 'SSH_TARGET_CHANGING') throw error;
        return null;
      });
      const [modelsRes, propsRes, slotsRes] = await Promise.all([
        safeProbe(executeCommand('curl', ['-s', `http://127.0.0.1:${port}/v1/models`], { timeoutMs: 3000 })),
        safeProbe(executeCommand('curl', ['-s', `http://127.0.0.1:${port}/props`], { timeoutMs: 3000 })),
        safeProbe(executeCommand('curl', ['-s', `http://127.0.0.1:${port}/slots`], { timeoutMs: 3000 }))
      ]);
      requireCurrentTarget(target.key);

      try {
        if (modelsRes?.stdout) {
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
        if (propsRes?.stdout) {
          serverProps = JSON.parse(propsRes.stdout);
          serverHealthy = true;
        }
      } catch (_) {}

      try {
        if (slotsRes?.stdout) {
          slots = JSON.parse(slotsRes.stdout);
        }
      } catch (_) {}
    }

    requireCurrentTarget(target.key);
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
        managedProcessStatus,
        hfTokenConfigured: Boolean(getConfig().hfToken)
      }
    });
  } catch (err) {
    const conflict = err.code === 'SSH_TARGET_CHANGED' || err.code === 'SSH_TARGET_CHANGING';
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// 2. Scan Local Models across Configured Model Roots
router.get('/local-models', async (req, res) => {
  let modelState = null;
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    modelState = localModelStateByTarget.get(target.key);
    const activeInstance = activeInstancesByTarget.get(target.key);
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();

    if (!forceRefresh && modelState.cached && (now - modelState.lastScanTime < 15000)) {
      return res.json({ success: true, data: modelState.cached });
    }

    if (modelState.scanPromise) {
      const data = await modelState.scanPromise;
      requireCurrentTarget(target.key);
      return res.json({ success: true, data });
    }

    const scanPromise = runCoalescedTargetScan(modelState, async () => {

    const modelRoots = getModelRoots();
    const dfRes = await executeCommand('df', ['-kP', '--', modelRoots[0]], { timeoutMs: 4000 });
    let diskStats = { total: '--', used: '--', free: '--', percent: '0%' };
    if (dfRes.stdout) {
      const diskLine = dfRes.stdout.trim().split('\n').at(-1) || '';
      const [, tot, used, free, pct] = diskLine.trim().split(/\s+/);
      if (tot && used) {
        diskStats = {
          total: formatBytes(parseInt(tot, 10) * 1024),
          used: formatBytes(parseInt(used, 10) * 1024),
          free: formatBytes(parseInt(free, 10) * 1024),
          percent: pct || '0%'
        };
      }
    }

    const rootsJson = JSON.stringify(modelRoots);
    const maxDepth = parseBoundedInteger(process.env.MODEL_SCAN_MAX_DEPTH || 4, 'MODEL_SCAN_MAX_DEPTH', 1, 20);

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
    requireCurrentTarget(target.key);
    let rawModels = [];
    if (!scanResult.success && !scanResult.stdout.trim()) {
      throw new Error(scanResult.stderr || 'Unable to scan configured model roots');
    }
    try {
      rawModels = JSON.parse(scanResult.stdout.trim());
    } catch (_) {
      throw new Error('Remote model scan returned malformed data');
    }

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

    modelState.cached = {
      disk: diskStats,
      models,
      activeModel: activeModelKeyword,
      target: target.label
    };
    modelState.lastScanTime = Date.now();
    return modelState.cached;
    });
    const data = await scanPromise;
    requireCurrentTarget(target.key);
    res.json({ success: true, data });
  } catch (err) {
    const conflict = err.code === 'SSH_TARGET_CHANGED' || err.code === 'SSH_TARGET_CHANGING';
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// Delete a local model file
router.delete('/local-models', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    const filePath = validateModelFilePath(req.body.filePath);
    const delRes = await executeCommand('rm', ['-f', filePath], { timeoutMs: 5000 });
    requireCurrentTarget(target.key);
    if (!delRes.success) {
      return res.status(500).json({ success: false, error: delRes.stderr || '删除失败' });
    }

    localModelStateByTarget.get(target.key).cached = null;
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
    const cleanQuery = String(q).trim().slice(0, 200);
    const cleanFilter = String(filter).trim().slice(0, 64);
    const cleanSort = ['downloads', 'likes', 'lastModified', 'trending'].includes(String(sort)) ? String(sort) : 'downloads';
    const cleanLimit = parseBoundedInteger(limit, 'limit', 1, 50, 30);

    let searchUrl = `${baseApi}/api/models?limit=${cleanLimit}&full=false&direction=-1`;
    if (cleanSort !== 'trending') searchUrl += `&sort=${encodeURIComponent(cleanSort)}`;
    if (cleanFilter) searchUrl += `&filter=${encodeURIComponent(cleanFilter)}`;
    if (cleanQuery) searchUrl += `&search=${encodeURIComponent(cleanQuery)}`;

    const hfRes = await fetchFromHuggingFace(searchUrl);

    if (!hfRes.ok) {
      try { await hfRes.body?.cancel(); } catch (_) {}
      const error = new Error(`HF API 响应失败 (${hfRes.status})`);
      error.code = 'HF_UPSTREAM_ERROR';
      throw error;
    }

    const searchText = await readBoundedResponseText(
      hfRes,
      MAX_HF_SEARCH_BYTES,
      'HF 搜索响应',
      'HF_SEARCH_TOO_LARGE'
    );
    let list;
    try {
      list = JSON.parse(searchText);
    } catch (_) {
      const error = new Error('HF 搜索响应不是有效 JSON');
      error.code = 'HF_UPSTREAM_INVALID';
      throw error;
    }
    if (!Array.isArray(list)) {
      const error = new Error('HF 搜索响应格式无效');
      error.code = 'HF_UPSTREAM_INVALID';
      throw error;
    }

    const results = list
      .filter((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string')
      .map(m => {
      const id = m.id.trim();
      if (!id || id.length > 200) return null;
      const name = id.split('/').pop() || id;
      const author = typeof m.author === 'string' && m.author.trim()
        ? m.author.trim().slice(0, 200)
        : id.split('/')[0] || 'Community';
      const tags = Array.isArray(m.tags)
        ? m.tags
          .filter((tag) => typeof tag === 'string')
          .map((tag) => tag.trim().slice(0, 128))
          .filter(Boolean)
          .slice(0, 6)
        : [];
      const paramMatch = name.match(/(\d+(\.\d+)?B|\d+x\d+B)/i);
      const paramScale = paramMatch ? paramMatch[0].toUpperCase() : '';

      return {
        id,
        author,
        name,
        paramScale,
        downloads: normalizeHfNonNegativeInteger(m.downloads),
        likes: normalizeHfNonNegativeInteger(m.likes),
        lastModified: typeof m.lastModified === 'string' ? m.lastModified.slice(0, 128) : null,
        pipeline_tag: typeof m.pipeline_tag === 'string' && m.pipeline_tag.trim()
          ? m.pipeline_tag.trim().slice(0, 100)
          : 'text-generation',
        tags,
        isGguf: tags.some((tag) => tag.toLowerCase() === 'gguf') || id.toLowerCase().includes('gguf')
      };
    })
      .filter(Boolean);

    res.json({ success: true, data: results });
  } catch (err) {
    const status = err.code === 'HF_SEARCH_TOO_LARGE'
      ? 413
      : err.code === 'HF_FETCH_TIMEOUT'
        ? 504
        : ['HF_UPSTREAM_INVALID', 'HF_UPSTREAM_ERROR'].includes(err.code)
          ? 502
          : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Fetch a bounded model card from the two supported Hugging Face origins.
router.get('/hf/readme', async (req, res) => {
  try {
    const repo = validateHfRepoId(req.query.repo);
    const mirror = req.query.mirror === 'true' || req.query.mirror === true;
    const baseUrl = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
    const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
    const readmeUrl = new URL(`${baseUrl}/${encodedRepo}/raw/main/README.md`);
    if (readmeUrl.protocol !== 'https:' || !['huggingface.co', 'hf-mirror.com'].includes(readmeUrl.hostname)) {
      throw new Error('README 地址不在允许的 Hugging Face 域名内');
    }

    const readmeResponse = await fetchFromHuggingFace(readmeUrl.toString());
    if (!readmeResponse.ok) {
      try { await readmeResponse.body?.cancel(); } catch (_) {}
      return res.status(502).json({
        success: false,
        error: `无法获取模型 README (上游状态 ${readmeResponse.status})`
      });
    }
    const readme = await readBoundedResponseText(readmeResponse);
    res.json({ success: true, repo, readme });
  } catch (err) {
    const status = err.code === 'HF_README_TOO_LARGE'
      ? 413
      : err.code === 'HF_FETCH_TIMEOUT'
        ? 504
        : err.code === 'HF_REPO_INVALID'
          ? 400
          : 502;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.post('/hf/token', (req, res) => {
  try {
    const token = validateHfAccessToken(req.body?.token, true);
    updateHfToken(token);
    res.json({ success: true, hasHfToken: Boolean(token) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get files in Hugging Face Repo
router.get('/hf/model-files', async (req, res) => {
  try {
    const { mirror = false } = req.query;
    const repo = validateHfRepoId(req.query.repo);
    const baseApi = mirror === 'true' || mirror === true ? 'https://hf-mirror.com' : 'https://huggingface.co';
    const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
    const treeUrl = `${baseApi}/api/models/${encodedRepo}/tree/main`;
    const treeRes = await fetchFromHuggingFace(treeUrl);

    if (!treeRes.ok) {
      try { await treeRes.body?.cancel(); } catch (_) {}
      const error = new Error(`无法获取该模型的文件列表 (${treeRes.status})`);
      error.code = 'HF_UPSTREAM_ERROR';
      throw error;
    }

    const treeText = await readBoundedResponseText(
      treeRes,
      MAX_HF_TREE_BYTES,
      'HF 文件树响应',
      'HF_TREE_TOO_LARGE'
    );
    let files;
    try {
      files = JSON.parse(treeText);
    } catch (_) {
      const error = new Error('HF 文件树响应不是有效 JSON');
      error.code = 'HF_UPSTREAM_INVALID';
      throw error;
    }
    if (!Array.isArray(files)) {
      const error = new Error('HF 文件树响应格式无效');
      error.code = 'HF_UPSTREAM_INVALID';
      throw error;
    }
    const ggufFiles = files
      .filter((f) => (
        f && typeof f === 'object' && !Array.isArray(f)
        && f.type === 'file'
        && typeof f.path === 'string'
        && f.path.length > 0
        && f.path.length <= 4096
        && !/[\u0000-\u001f\u007f]/.test(f.path)
        && f.path.toLowerCase().endsWith('.gguf')
      ))
      .map(f => {
        const sizeBytes = normalizeHfNonNegativeInteger(f.size);
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
          downloadUrl: `${baseApi}/${encodedRepo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`
        };
      });

    res.json({
      success: true,
      data: { repo, baseApi, files: ggufFiles }
    });
  } catch (err) {
    const status = err.code === 'HF_TREE_TOO_LARGE'
      ? 413
      : err.code === 'HF_FETCH_TIMEOUT'
        ? 504
        : err.code === 'HF_REPO_INVALID'
          ? 400
          : ['HF_UPSTREAM_INVALID', 'HF_UPSTREAM_ERROR'].includes(err.code)
            ? 502
            : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

export function parseRecoveredDownloadState(rawState, rawIdentity, targetIdentity, runtimeDir) {
  const safeRuntimeDir = validatePrivateRuntimeDirectory(runtimeDir, 'download');
  const record = parseManagedStateJson(rawState, 'download', targetIdentity, safeRuntimeDir);
  const identity = parseManagedIdentity(rawIdentity);
  const id = String(record.id || '');
  if (!/^task_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Recovered download task ID is invalid');
  }
  const destFile = validateModelDownloadPath(record.destFile);
  const filename = path.posix.basename(destFile);
  if (filename !== record.filename || !filename.toLowerCase().endsWith('.gguf')) {
    throw new Error('Recovered download destination is invalid');
  }
  const partFile = validateModelDownloadPath(record.partFile);
  if (partFile !== `${destFile}.${id}.part`) throw new Error('Recovered download temporary file is invalid');
  const totalBytes = normalizeHfNonNegativeInteger(record.totalBytes);
  if (totalBytes !== record.totalBytes) throw new Error('Recovered download size is invalid');
  const startTime = Number(record.startTime);
  if (!Number.isSafeInteger(startTime) || startTime <= 0) throw new Error('Recovered download start time is invalid');
  if (typeof record.hasTokenConfig !== 'boolean') throw new Error('Recovered download token-config state is invalid');
  const repo = String(record.repo || filename).slice(0, 512);
  return {
    id,
    targetIdentity,
    targetLabel: String(record.targetLabel || '').slice(0, 512),
    repo,
    filename,
    destFile,
    partFile,
    downloadUrl: validateHfDownloadUrl(record.downloadUrl),
    pid: identity.pid,
    pidStartTime: identity.pidStartTime,
    ownershipToken: validateOwnershipToken(record.ownershipToken),
    runtimeDir: safeRuntimeDir,
    statePath: managedRuntimeFilePath(safeRuntimeDir, 'download', MANAGED_STATE_FILE),
    identityPath: managedRuntimeFilePath(safeRuntimeDir, 'download', MANAGED_IDENTITY_FILE),
    exitStatusPath: managedRuntimeFilePath(safeRuntimeDir, 'download', DOWNLOAD_EXIT_STATUS_FILE),
    completionPath: managedRuntimeFilePath(safeRuntimeDir, 'download', DOWNLOAD_COMPLETION_FILE),
    exitStatusTempPath: managedRuntimeFilePath(safeRuntimeDir, 'download', DOWNLOAD_EXIT_STATUS_TEMP_FILE),
    completionTempPath: managedRuntimeFilePath(safeRuntimeDir, 'download', DOWNLOAD_COMPLETION_TEMP_FILE),
    logFile: managedRuntimeFilePath(safeRuntimeDir, 'download', 'download.log'),
    tokenConfigPath: record.hasTokenConfig
      ? managedRuntimeFilePath(safeRuntimeDir, 'download', 'curl.conf')
      : '',
    status: 'downloading',
    totalBytes,
    downloadedBytes: 0,
    percent: 0,
    speedFormatted: '-- MB/s',
    etaFormatted: '--',
    startTime,
    lastBytes: 0,
    lastCheckTime: Date.now(),
    cancelRequested: false,
    startupSettled: true,
    cleanupComplete: false,
    refreshPromise: null
  };
}

export const DOWNLOAD_STATUS_SCRIPT = `
part_file="$1"
final_file="$2"
pid="$3"
expected_start="$4"
marker="$5"
expected_token="$6"
completion_file="$7"
exit_status_file="$8"
size=$(stat -c %s -- "$part_file" 2>/dev/null || echo 0)
status="FAILED"
if kill -0 "$pid" 2>/dev/null; then
  actual_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
  if [ "$actual_start" = "$expected_start" ] &&
     tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fqx -- "$marker" &&
     tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx -- "LLM_MANAGER_DOWNLOAD_TOKEN=$expected_token"; then
    status="RUNNING"
  else
    status="IDENTITY_MISMATCH"
  fi
fi
if [ "$status" != "RUNNING" ]; then
  uid=$(id -u 2>/dev/null || true)
  read_private_state() {
    private_file="$1"
    max_bytes="$2"
    [ -f "$private_file" ] && [ ! -L "$private_file" ] || return 1
    [ "$(stat -c '%u' -- "$private_file" 2>/dev/null)" = "$uid" ] || return 1
    [ "$(stat -c '%a' -- "$private_file" 2>/dev/null)" = 600 ] || return 1
    private_size=$(stat -c '%s' -- "$private_file" 2>/dev/null) || return 1
    case "$private_size" in *[!0-9]*|'') return 1 ;; esac
    [ "$private_size" -le "$max_bytes" ] || return 1
    cat -- "$private_file"
  }
  exit_status=$(read_private_state "$exit_status_file" 16 2>/dev/null || true)
  completion_token=$(read_private_state "$completion_file" 128 2>/dev/null || true)
  if [ "$exit_status" = 0 ] && [ "$completion_token" = "$expected_token" ] &&
     [ -f "$final_file" ] && [ ! -L "$final_file" ]; then
    status="COMPLETED"
    size=$(stat -c %s -- "$final_file" 2>/dev/null || echo 0)
  fi
fi
printf 'SIZE:%s\nSTATUS:%s\n' "$size" "$status"
`.trim();

export const DOWNLOAD_TRANSFER_SCRIPT = `
token_config="$1"
part_file="$2"
final_file="$3"
exit_status_file="$4"
completion_file="$5"
shift 5
finish() {
  status=$?
  [ -n "$token_config" ] && rm -f -- "$token_config"
  umask 077
  printf "%s\\n" "$status" > "$exit_status_file.tmp" &&
    chmod 600 -- "$exit_status_file.tmp" &&
    mv -- "$exit_status_file.tmp" "$exit_status_file"
}
trap finish EXIT
trap "exit 143" HUP INT TERM
if curl "$@" && mv -fT -- "$part_file" "$final_file"; then
  umask 077
  printf "%s\\n" "$LLM_MANAGER_DOWNLOAD_TOKEN" > "$completion_file.tmp" &&
    chmod 600 -- "$completion_file.tmp" &&
    mv -- "$completion_file.tmp" "$completion_file" || exit 1
  exit 0
fi
exit 1
`.trim();

export const DOWNLOAD_LAUNCH_SCRIPT = `
manager_token="$1"
token_config="$2"
part_file="$3"
final_file="$4"
log_file="$5"
identity_file="$6"
exit_status_file="$7"
completion_file="$8"
shift 8
LLM_MANAGER_DOWNLOAD_TOKEN="$manager_token" nohup sh -c '${DOWNLOAD_TRANSFER_SCRIPT}' \
  sh "$token_config" "$part_file" "$final_file" "$exit_status_file" "$completion_file" "$@" \
  > "$log_file" 2>&1 < /dev/null &
pid=$!
start_time=""
attempt=0
while [ "$attempt" -lt 20 ]; do
  start_time=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
  [ -n "$start_time" ] && break
  attempt=$((attempt + 1))
  sleep 0.02
done
if ! printf '%s' "$pid" | grep -Eq '^[0-9]+$' || ! printf '%s' "$start_time" | grep -Eq '^[0-9]+$'; then
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  exit 1
fi
if ! (umask 077 && printf '%s %s\n' "$pid" "$start_time" > "$identity_file"); then
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  exit 1
fi
printf '%s %s\n' "$pid" "$start_time"
`.trim();

export const CANCEL_DOWNLOAD_SCRIPT = `
pid="$1"
expected_start="$2"
marker="$3"
token_config="$4"
part_file="$5"
log_file="$6"
expected_token="$7"
runtime_dir="$8"
state_file="$9"
identity_file="\${10}"
exit_status_file="\${11}"
completion_file="\${12}"
exit_status_temp_file="\${13}"
completion_temp_file="\${14}"

case "$runtime_dir" in
  /tmp/llm-manager-download.[A-Za-z0-9]*) ;;
  *) echo "STATUS:IDENTITY_MISMATCH"; exit 42 ;;
esac
uid=$(id -u 2>/dev/null || true)
if [ -z "$uid" ] || [ ! -d "$runtime_dir" ] || [ -L "$runtime_dir" ] ||
   [ "$(stat -c '%u' -- "$runtime_dir" 2>/dev/null)" != "$uid" ] ||
   [ "$(stat -c '%a' -- "$runtime_dir" 2>/dev/null)" != 700 ]; then
  echo "STATUS:IDENTITY_MISMATCH"
  exit 42
fi

identity_matches() {
  actual_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
  [ "$actual_start" = "$expected_start" ] &&
    tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fqx -- "$marker" &&
    tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx -- "LLM_MANAGER_DOWNLOAD_TOKEN=$expected_token"
}

if kill -0 "$pid" 2>/dev/null; then
  if [ -z "$expected_token" ] || ! identity_matches; then
    echo "STATUS:IDENTITY_MISMATCH"
    exit 42
  fi
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  count=0
  while kill -0 "$pid" 2>/dev/null && identity_matches && [ "$count" -lt 20 ]; do
    sleep 0.1
    count=$((count + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    if identity_matches; then
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      sleep 0.1
    fi
  fi
  if kill -0 "$pid" 2>/dev/null && identity_matches; then
    echo "STATUS:STOP_FAILED"
    exit 43
  fi
fi
[ -n "$token_config" ] && rm -f -- "$token_config"
[ -n "$part_file" ] && rm -f -- "$part_file"
[ -n "$log_file" ] && rm -f -- "$log_file"
[ -n "$state_file" ] && rm -f -- "$state_file"
[ -n "$identity_file" ] && rm -f -- "$identity_file"
[ -n "$exit_status_file" ] && rm -f -- "$exit_status_file"
[ -n "$completion_file" ] && rm -f -- "$completion_file"
[ -n "$exit_status_temp_file" ] && rm -f -- "$exit_status_temp_file"
[ -n "$completion_temp_file" ] && rm -f -- "$completion_temp_file"
if ! rmdir -- "$runtime_dir" 2>/dev/null; then
  echo "STATUS:CLEANUP_FAILED"
  exit 44
fi
echo "STATUS:CANCELED"
`.trim();

export async function cancelTargetDownloadTask(task, currentTargetIdentity, executor = executeCommand) {
  if (!task || task.targetIdentity !== currentTargetIdentity) {
    return { canceled: false, reason: 'target-mismatch' };
  }
  if (!task.pidStartTime || !task.ownershipToken) {
    const error = new Error('Download process identity is incomplete; refusing to signal or clean it');
    error.code = 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }
  const runtimeDir = validatePrivateRuntimeDirectory(task.runtimeDir, 'download');
  const partFile = validateModelDownloadPath(task.partFile);
  const runtimeFiles = [
    task.tokenConfigPath,
    task.logFile,
    task.statePath,
    task.identityPath,
    task.exitStatusPath,
    task.completionPath,
    task.exitStatusTempPath,
    task.completionTempPath
  ].filter(Boolean).map((filePath) => validateSafePath(filePath));
  if (runtimeFiles.some((filePath) => path.posix.dirname(filePath) !== runtimeDir)) {
    const error = new Error('Download runtime files are outside the task private directory');
    error.code = 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }
  const result = await executor(
    'sh',
    [
      '-c', CANCEL_DOWNLOAD_SCRIPT, 'sh',
      String(task.pid || ''), String(task.pidStartTime || ''), partFile,
      String(task.tokenConfigPath || ''), partFile, String(task.logFile || ''),
      String(task.ownershipToken), runtimeDir, String(task.statePath || ''),
      String(task.identityPath || ''), String(task.exitStatusPath || ''),
      String(task.completionPath || ''), String(task.exitStatusTempPath || ''),
      String(task.completionTempPath || '')
    ],
    { timeoutMs: 5000 }
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (output.includes('STATUS:IDENTITY_MISMATCH')) {
    const error = new Error('Refusing to cancel a download PID that no longer belongs to this task');
    error.code = 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }
  if (!result.success || !output.includes('STATUS:CANCELED')) {
    throw new Error(result.stderr || 'Unable to cancel the download task');
  }
  return { canceled: true };
}

export async function inspectManagedDownloadProcess(
  task,
  currentTargetIdentity,
  executor = executeCommand
) {
  if (!task || task.targetIdentity !== currentTargetIdentity) {
    return { status: 'target-mismatch', downloadedBytes: 0 };
  }
  if (!task.pid || !task.pidStartTime || !task.ownershipToken) {
    throw new Error('Download process identity is incomplete');
  }
  validateOwnershipToken(task.ownershipToken);
  const runtimeDir = validatePrivateRuntimeDirectory(task.runtimeDir, 'download');
  const partFile = validateModelDownloadPath(task.partFile);
  const finalFile = validateModelDownloadPath(task.destFile);
  const completionPath = validateSafePath(task.completionPath);
  const exitStatusPath = validateSafePath(task.exitStatusPath);
  if ([completionPath, exitStatusPath].some((filePath) => path.posix.dirname(filePath) !== runtimeDir)) {
    throw new Error('Download completion state is outside the task private directory');
  }
  const result = await executor(
    'sh',
    [
      '-c', DOWNLOAD_STATUS_SCRIPT, 'sh', partFile, finalFile,
      String(task.pid), String(task.pidStartTime), partFile,
      String(task.ownershipToken), completionPath, exitStatusPath
    ],
    { timeoutMs: 2000 }
  );
  if (!result.success && !result.stdout) {
    throw new Error(result.stderr || 'Unable to inspect the managed download process');
  }
  const downloadedBytes = Number.parseInt(String(result.stdout || '').match(/SIZE:(\d+)/)?.[1] || '0', 10);
  const statusText = String(result.stdout || '').match(/STATUS:([A-Z_]+)/)?.[1] || 'FAILED';
  const status = statusText === 'RUNNING'
    ? 'downloading'
    : statusText === 'COMPLETED'
      ? 'completed'
      : 'error';
  return { status, downloadedBytes: normalizeHfNonNegativeInteger(downloadedBytes), remoteStatus: statusText };
}

export function applyDownloadInspection(task, inspection, now = Date.now()) {
  task.downloadedBytes = normalizeHfNonNegativeInteger(inspection.downloadedBytes);
  if (inspection.status === 'completed' || inspection.status === 'error') {
    task.status = inspection.status;
    task.finishedAt = now;
    task.pid = null;
    task.pidStartTime = null;
    if (inspection.status === 'completed') task.percent = 100;
    else task.error = inspection.remoteStatus === 'IDENTITY_MISMATCH'
      ? '下载进程身份校验失败'
      : '下载进程未成功完成';
    return task;
  }
  task.status = 'downloading';
  if (task.totalBytes > 0) {
    task.percent = Math.min(99, Math.round((task.downloadedBytes / task.totalBytes) * 100));
  }
  const timeDelta = (now - task.lastCheckTime) / 1000;
  if (timeDelta >= 1) {
    const bytesDelta = task.downloadedBytes - task.lastBytes;
    const bytesPerSec = bytesDelta / timeDelta;
    if (bytesPerSec > 0) {
      task.speedFormatted = `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
      if (task.totalBytes > task.downloadedBytes) {
        const remainingSec = Math.round((task.totalBytes - task.downloadedBytes) / bytesPerSec);
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        task.etaFormatted = mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`;
      }
    }
    task.lastBytes = task.downloadedBytes;
    task.lastCheckTime = now;
  }
  return task;
}

async function cleanupDownloadTaskFiles(task) {
  let firstError = null;
  if (task?.partFile) {
    try {
      const safePartFile = validateModelDownloadPath(task.partFile);
      const removeResult = await executeCommand('rm', ['-f', '--', safePartFile], { timeoutMs: 3000 });
      if (!removeResult.success) throw new Error(removeResult.stderr || 'Unable to clean download temporary file');
    } catch (error) {
      firstError = error;
    }
  }
  if (task?.runtimeDir) {
    try {
      await cleanupPrivateRuntimeDirectory(
        task.runtimeDir,
        'download',
        [
          task.tokenConfigPath,
          task.logFile,
          task.statePath,
          task.identityPath,
          task.exitStatusPath,
          task.completionPath,
          task.exitStatusTempPath,
          task.completionTempPath
        ]
      );
      task.runtimeDir = null;
      task.tokenConfigPath = '';
      task.logFile = '';
      task.statePath = '';
      task.identityPath = '';
      task.exitStatusPath = '';
      task.completionPath = '';
      task.exitStatusTempPath = '';
      task.completionTempPath = '';
      task.cleanupComplete = true;
    } catch (error) {
      firstError ||= error;
    }
  }
  if (!firstError) task.cleanupComplete = true;
  if (firstError) throw firstError;
}

export async function settleCanceledDownloadTask(
  task,
  targetIdentity,
  dependencies = {}
) {
  if (!task || task.targetIdentity !== targetIdentity) {
    const error = new Error('Download task target does not match the active SSH target');
    error.code = 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH';
    throw error;
  }
  if (task.cleanupComplete) {
    task.status = 'canceled';
    return task;
  }
  const cancelProcess = dependencies.cancelProcess || cancelTargetDownloadTask;
  const cleanupFiles = dependencies.cleanupFiles || cleanupDownloadTaskFiles;
  if (task.pid) {
    const result = await cancelProcess(task, targetIdentity);
    if (!result?.canceled) {
      const error = new Error('Download task does not belong to the active SSH target');
      error.code = 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH';
      throw error;
    }
    task.cleanupComplete = true;
  } else {
    await cleanupFiles(task);
    task.cleanupComplete = true;
  }
  task.status = 'canceled';
  task.finishedAt = Date.now();
  return task;
}

async function refreshDownloadTask(task, targetIdentity) {
  if (task.refreshPromise) return task.refreshPromise;
  let refreshPromise;
  refreshPromise = Promise.resolve()
    .then(async () => {
      requireCurrentTarget(targetIdentity);
      const inspection = await inspectManagedDownloadProcess(task, targetIdentity);
      requireCurrentTarget(targetIdentity);
      applyDownloadInspection(task, inspection);
      if (['completed', 'error'].includes(task.status) && !task.cleanupComplete) {
        try {
          await cleanupDownloadTaskFiles(task);
        } catch (error) {
          if (error?.code === 'SSH_TARGET_CHANGED' || error?.code === 'SSH_TARGET_CHANGING') throw error;
          console.warn('[LLM] Failed to clean private download runtime directory:', error.message);
        }
      }
      return task;
    })
    .finally(() => {
      if (task.refreshPromise === refreshPromise) task.refreshPromise = null;
    });
  task.refreshPromise = refreshPromise;
  return refreshPromise;
}

async function recoverAmbiguousDownloadTask(task, targetIdentity) {
  if (!task?.launchAmbiguous) return task;
  const recovered = await readManagedRuntimeStateAtPath(
    'download',
    targetIdentity,
    task.runtimeDir,
    parseRecoveredDownloadState
  );
  const cancelRequested = Boolean(task.cancelRequested);
  const startupSettled = task.startupSettled;
  const startupSettledPromise = task.startupSettledPromise;
  Object.assign(task, recovered, {
    cancelRequested,
    startupSettled,
    startupSettledPromise,
    launchAmbiguous: false
  });
  await refreshDownloadTask(task, targetIdentity);
  if (task.status === 'downloading') downloadTaskReaper.watch(task, targetIdentity);
  return task;
}

export class DownloadTaskReaper {
  constructor(refresh, options = {}) {
    if (typeof refresh !== 'function') throw new TypeError('DownloadTaskReaper requires a refresh function');
    this.refresh = refresh;
    this.intervalMs = options.intervalMs || DOWNLOAD_REAPER_INTERVAL_MS;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onError = options.onError || (() => {});
    this.timers = new Map();
  }

  key(task, targetIdentity) {
    return `${targetIdentity}\u0000${task.id}`;
  }

  watch(task, targetIdentity, delayMs = this.intervalMs) {
    if (!task || task.status !== 'downloading') return;
    const key = this.key(task, targetIdentity);
    if (this.timers.has(key)) return;
    const timer = this.setTimer(async () => {
      this.timers.delete(key);
      if (task.status !== 'downloading') return;
      try {
        await this.refresh(task, targetIdentity);
      } catch (error) {
        this.onError(error, task, targetIdentity);
      }
      if (task.status === 'downloading') this.watch(task, targetIdentity);
    }, delayMs);
    timer?.unref?.();
    this.timers.set(key, timer);
  }

  unwatch(task, targetIdentity) {
    if (!task) return;
    const key = this.key(task, targetIdentity);
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(key);
  }
}

const downloadTaskReaper = new DownloadTaskReaper((task, targetIdentity) => {
  const currentTarget = resolveSshTargetIdentity();
  if (currentTarget.key !== targetIdentity) {
    const error = new Error('Download task belongs to a different SSH target');
    error.code = 'SSH_TARGET_CHANGED';
    throw error;
  }
  const freshContext = captureSshTargetContext();
  return runWithSshTargetContext(freshContext, () => refreshDownloadTask(task, targetIdentity));
}, {
  onError(error) {
    if (!['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING'].includes(error?.code)) {
      console.warn('[LLM] Background download status check failed:', error.message);
    }
  }
});

async function recoverManagedLlamaForTarget(target) {
  if (activeInstancesByTarget.peek(target.key)?.pid) return false;
  const candidates = await readManagedRuntimeStates('llama', target, parseRecoveredLlamaState);
  const running = [];
  for (const instance of candidates) {
    requireCurrentTarget(target.key);
    const status = await inspectManagedLlamaProcess(instance, target.key);
    if (status === 'running') {
      instance.isRunning = true;
      running.push(instance);
      continue;
    }
    try {
      await cleanupManagedLlamaRuntime(instance);
    } catch (error) {
      console.warn('[LLM] Failed to clean stale recovered llama state:', error.message);
    }
  }
  if (running.length > 0) {
    running.sort((left, right) => right.launchedAt - left.launchedAt);
    if (running.length > 1) {
      for (const duplicate of running.slice(1)) {
        requireCurrentTarget(target.key);
        await terminateManagedLlamaProcess(duplicate, target.key);
        await cleanupManagedLlamaRuntime(duplicate);
      }
      console.warn(`[LLM] Recovered ${running.length} managed llama-server processes on ${target.label}; safely stopped ${running.length - 1} older duplicate(s).`);
    }
    activeInstancesByTarget.set(target.key, running[0]);
  }
  return Boolean(activeInstancesByTarget.peek(target.key)?.launchAmbiguous
    && !activeInstancesByTarget.peek(target.key)?.pid);
}

async function recoverManagedDownloadsForTarget(target) {
  const tasks = downloadTasksByTarget.get(target.key);
  let unresolved = false;
  for (const task of tasks.values()) {
    if (!task.launchAmbiguous) continue;
    try {
      await recoverAmbiguousDownloadTask(task, target.key);
    } catch (error) {
      if (error?.code === 'SSH_TARGET_CHANGED' || error?.code === 'SSH_TARGET_CHANGING') throw error;
      unresolved = true;
    }
  }
  const recovered = await readManagedRuntimeStates('download', target, parseRecoveredDownloadState);
  for (const task of recovered) {
    if (tasks.has(task.id)) continue;
    tasks.set(task.id, task);
    try {
      await refreshDownloadTask(task, target.key);
    } catch (error) {
      if (error?.code === 'SSH_TARGET_CHANGED' || error?.code === 'SSH_TARGET_CHANGING') throw error;
      console.warn(`[LLM] Could not immediately inspect recovered download ${task.id}:`, error.message);
    }
    if (task.status === 'downloading') downloadTaskReaper.watch(task, target.key);
  }
  return unresolved;
}

async function ensureManagedStateRecovered(target) {
  const recovery = managedStateRecoveryByTarget.get(target.key);
  const ambiguousInstance = activeInstancesByTarget.peek(target.key);
  if (ambiguousInstance?.launchAmbiguous && !ambiguousInstance.pid) recovery.complete = false;
  if (recovery.complete) return;
  if (recovery.promise) return recovery.promise;
  let recoveryPromise;
  recoveryPromise = Promise.resolve()
    .then(async () => {
      const llamaUnresolved = await recoverManagedLlamaForTarget(target);
      const downloadsUnresolved = await recoverManagedDownloadsForTarget(target);
      requireCurrentTarget(target.key);
      recovery.complete = !llamaUnresolved && !downloadsUnresolved;
    })
    .finally(() => {
      if (recovery.promise === recoveryPromise) recovery.promise = null;
    });
  recovery.promise = recoveryPromise;
  return recoveryPromise;
}

export function requestDownloadCancellation(task) {
  if (!task) return;
  task.cancelRequested = true;
  if (ACTIVE_DOWNLOAD_STATUSES.has(task.status)) task.status = 'canceling';
}

export function assertDownloadInitializationActive(task) {
  if (task?.cancelRequested) {
    const error = new Error('下载任务已取消');
    error.code = 'DOWNLOAD_CANCELED';
    throw error;
  }
}

// 4. Download Model without exposing tokens in process arguments
router.post('/hf/download', async (req, res) => {
  let target = null;
  let task = null;
  let tasks = null;
  try {
    target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    pruneDownloadTasks();
    tasks = downloadTasksByTarget.get(target.key);
    const { repo, filename, downloadUrl, targetDir, hfToken } = req.body;
    if (!filename || !downloadUrl) {
      return res.status(400).json({ success: false, error: '缺少下载参数' });
    }

    const safeTargetDir = validateModelTargetDir(targetDir || getModelRoots()[0]);
    const safeFilename = path.posix.basename(String(filename).replace(/\\/g, '/'));
    if (
      !safeFilename || !safeFilename.toLowerCase().endsWith('.gguf')
      || /[\u0000-\u001f\u007f]/.test(safeFilename)
      || Buffer.byteLength(safeFilename, 'utf8') > 255
    ) {
      throw new Error('仅允许下载文件名有效的 GGUF 模型文件');
    }
    const safeDownloadUrl = validateHfDownloadUrl(downloadUrl);
    const taskId = `task_${crypto.randomUUID()}`;
    const finalFile = path.posix.join(safeTargetDir, safeFilename);
    const partFile = `${finalFile}.${taskId}.part`;
    if ([...tasks.values()].some((item) => ACTIVE_DOWNLOAD_STATUSES.has(item.status) && item.destFile === finalFile)) {
      return res.status(409).json({ success: false, error: '该模型文件已有正在运行的下载任务' });
    }
    const activeTaskCount = [...tasks.values()].filter((item) => ACTIVE_DOWNLOAD_STATUSES.has(item.status)).length;
    if (activeTaskCount >= MAX_ACTIVE_MODEL_DOWNLOADS) {
      return res.status(429).json({ success: false, error: '活动下载任务已达到上限' });
    }

    const now = Date.now();
    task = {
      id: taskId,
      targetIdentity: target.key,
      targetLabel: target.label,
      repo: repo || safeFilename,
      filename: safeFilename,
      destFile: finalFile,
      partFile,
      downloadUrl: safeDownloadUrl,
      pid: null,
      pidStartTime: null,
      ownershipToken: crypto.randomUUID(),
      runtimeDir: null,
      statePath: '',
      identityPath: '',
      exitStatusPath: '',
      completionPath: '',
      exitStatusTempPath: '',
      completionTempPath: '',
      logFile: '',
      tokenConfigPath: '',
      status: 'starting',
      totalBytes: parseBoundedInteger(req.body.totalBytes, 'totalBytes', 0, Number.MAX_SAFE_INTEGER, 0),
      downloadedBytes: 0,
      percent: 0,
      speedFormatted: '-- MB/s',
      etaFormatted: '--',
      startTime: now,
      lastBytes: 0,
      lastCheckTime: now,
      cancelRequested: false,
      launchDispatched: false,
      launchAmbiguous: false,
      startupSettled: false,
      cleanupComplete: false,
      startupError: null,
      refreshPromise: null,
      resolveStartupSettled: null,
      startupSettledPromise: null
    };
    task.startupSettledPromise = new Promise((resolve) => {
      task.resolveStartupSettled = resolve;
    });
    // Reserve both the slot and destination before the first await.
    tasks.set(taskId, task);

    assertDownloadInitializationActive(task);
    requireCurrentTarget(target.key);
    const mkdirResult = await executeCommand('mkdir', ['-p', safeTargetDir]);
    if (!mkdirResult.success) throw new Error(mkdirResult.stderr || '无法创建模型目标目录');
    assertDownloadInitializationActive(task);
    requireCurrentTarget(target.key);
    task.runtimeDir = await createPrivateRuntimeDirectory('download');
    assertDownloadInitializationActive(task);
    task.logFile = await createPrivateRuntimeFile(task.runtimeDir, 'download', 'download.log');
    assertDownloadInitializationActive(task);
    requireCurrentTarget(target.key);
    if (hfToken !== undefined && hfToken !== null && (typeof hfToken !== 'string' || hfToken.trim())) {
      updateHfToken(validateHfAccessToken(hfToken));
    }

    const storedToken = getConfig().hfToken;
    const effectiveToken = typeof storedToken === 'string' && storedToken.trim()
      ? validateHfAccessToken(storedToken)
      : '';
    const curlArgs = [
      '--fail', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '10',
      '--continue-at', '-', '--output', partFile, safeDownloadUrl
    ];
    let activeTokenConfig = '';
    if (effectiveToken) {
      task.tokenConfigPath = await createPrivateRuntimeFile(
        task.runtimeDir,
        'download',
        'curl.conf',
        buildCurlTokenConfig(effectiveToken)
      );
      assertDownloadInitializationActive(task);
      requireCurrentTarget(target.key);
      curlArgs.unshift('--config', task.tokenConfigPath);
      activeTokenConfig = task.tokenConfigPath;
    }

    task.statePath = await createPrivateRuntimeFile(
      task.runtimeDir,
      'download',
      MANAGED_STATE_FILE,
      serializeManagedState({
        version: MANAGED_STATE_VERSION,
        kind: 'download',
        targetIdentity: target.key,
        targetLabel: target.label,
        ownershipToken: task.ownershipToken,
        runtimeDir: task.runtimeDir,
        id: task.id,
        repo: task.repo,
        filename: task.filename,
        destFile: task.destFile,
        partFile: task.partFile,
        downloadUrl: task.downloadUrl,
        totalBytes: task.totalBytes,
        startTime: task.startTime,
        hasTokenConfig: Boolean(activeTokenConfig)
      })
    );
    assertDownloadInitializationActive(task);
    task.identityPath = await createPrivateRuntimeFile(task.runtimeDir, 'download', MANAGED_IDENTITY_FILE);
    assertDownloadInitializationActive(task);
    task.exitStatusPath = managedRuntimeFilePath(task.runtimeDir, 'download', DOWNLOAD_EXIT_STATUS_FILE);
    task.exitStatusTempPath = await createPrivateRuntimeFile(
      task.runtimeDir,
      'download',
      DOWNLOAD_EXIT_STATUS_TEMP_FILE
    );
    assertDownloadInitializationActive(task);
    task.completionPath = managedRuntimeFilePath(task.runtimeDir, 'download', DOWNLOAD_COMPLETION_FILE);
    task.completionTempPath = await createPrivateRuntimeFile(
      task.runtimeDir,
      'download',
      DOWNLOAD_COMPLETION_TEMP_FILE
    );
    assertDownloadInitializationActive(task);

    // No await occurs between this final cancellation gate and dispatching the
    // remote launch. A cancellation accepted before this point cannot start curl.
    assertDownloadInitializationActive(task);
    task.launchDispatched = true;
    task.status = 'launching';
    requireCurrentTarget(target.key);
    const startRes = await executeCommand(
      'sh',
      [
        '-c', DOWNLOAD_LAUNCH_SCRIPT, 'sh', task.ownershipToken, activeTokenConfig,
        partFile, finalFile, task.logFile, task.identityPath,
        task.exitStatusPath, task.completionPath, ...curlArgs
      ]
    );
    const identityLine = startRes.stdout?.trim().split('\n').at(-1) || '';
    let identityMatch = startRes.success ? identityLine.match(/^(\d+)\s+(\d+)$/) : null;
    let recoveredAfterAmbiguousResponse = false;
    let stateReadError = null;
    if (!startRes.success || !identityMatch) {
      try {
        const recovered = await readManagedRuntimeStateAtPath(
          'download', target.key, task.runtimeDir, parseRecoveredDownloadState
        );
        identityMatch = [null, recovered.pid, recovered.pidStartTime];
        recoveredAfterAmbiguousResponse = true;
      } catch (error) {
        stateReadError = error;
      }
    }
    if (!identityMatch) {
      const ambiguous = Boolean(
        startRes.success
        || startRes.timeout
        || startRes.aborted
        || startRes.code === -1
        || ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING'].includes(stateReadError?.code)
      );
      const launchError = new Error(
        startRes.stderr || stateReadError?.message || '模型下载启动结果未知，已保留安全恢复状态'
      );
      if (ambiguous) launchError.code = 'DOWNLOAD_LAUNCH_AMBIGUOUS';
      throw launchError;
    }

    task.pid = identityMatch[1];
    task.pidStartTime = identityMatch[2];
    task.status = 'downloading';
    task.launchAmbiguous = false;
    assertDownloadInitializationActive(task);
    downloadTaskReaper.watch(task, target.key);

    res.json({
      success: true,
      taskId,
      target: target.label,
      recoveredAfterAmbiguousResponse,
      message: `已开始下载 ${safeFilename} 到 ${finalFile}`
    });
  } catch (err) {
    const launchAmbiguous = err.code === 'DOWNLOAD_LAUNCH_AMBIGUOUS';
    if (task) {
      task.status = launchAmbiguous ? 'launching' : (err.code === 'DOWNLOAD_CANCELED' ? 'canceling' : 'error');
      task.launchAmbiguous = launchAmbiguous;
      task.finishedAt = launchAmbiguous ? null : Date.now();
      task.error = err.message;
    }
    if (task && target && !launchAmbiguous) {
      try {
        requireCurrentTarget(target.key);
        if (task.cancelRequested) {
          await settleCanceledDownloadTask(task, target.key);
        } else {
          await cleanupDownloadTaskFiles(task);
        }
      } catch (cleanupError) {
        task.startupError = cleanupError;
      }
      if (err.code === 'DOWNLOAD_CANCELED' && !task.startupError) task.status = 'canceled';
    }
    if (launchAmbiguous && target) {
      const recovery = managedStateRecoveryByTarget.get(target.key);
      recovery.complete = false;
    }
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'DOWNLOAD_CANCELED'].includes(err.code);
    res.status(launchAmbiguous ? 503 : (conflict ? 409 : 400))
      .json({ success: false, error: err.message, retryable: launchAmbiguous });
  } finally {
    if (task) {
      task.startupSettled = true;
      task.resolveStartupSettled?.();
      task.resolveStartupSettled = null;
    }
  }
});

// Download Task Status
router.get('/hf/tasks', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    const tasksList = [];
    await ensureManagedStateRecovered(target);
    pruneDownloadTasks();
    const tasks = downloadTasksByTarget.get(target.key);

    for (const [, task] of tasks.entries()) {
      if (task.status === 'downloading') {
        await refreshDownloadTask(task, target.key);
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

    res.json({ success: true, target: target.label, tasks: tasksList });
  } catch (err) {
    res.status(err.code === 'SSH_TARGET_CHANGED' || err.code === 'SSH_TARGET_CHANGING' ? 409 : 500)
      .json({ success: false, error: err.message });
  }
});

// Cancel a download task
router.post('/hf/tasks/:id/cancel', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    const { id } = req.params;
    const tasks = downloadTasksByTarget.get(target.key);
    const task = tasks.get(id);
    if (!task) {
      const foreignTask = findDownloadTask(id);
      if (foreignTask) {
        return res.status(409).json({ success: false, error: '该下载任务属于另一台 SSH 服务器，已拒绝跨服务器取消' });
      }
      return res.status(404).json({ success: false, error: '任务不存在' });
    }

    downloadTaskReaper.unwatch(task, target.key);
    requestDownloadCancellation(task);

    if (!task.startupSettled && task.startupSettledPromise) {
      await task.startupSettledPromise;
    }
    if (task.refreshPromise) {
      try { await task.refreshPromise; } catch (_) {}
    }
    if (task.launchAmbiguous) {
      try {
        await recoverAmbiguousDownloadTask(task, target.key);
      } catch (error) {
        const ambiguousError = new Error('下载进程启动结果仍不确定；已保留身份状态，稍后重试取消');
        ambiguousError.code = 'DOWNLOAD_LAUNCH_AMBIGUOUS';
        ambiguousError.cause = error;
        throw ambiguousError;
      }
    }
    downloadTaskReaper.unwatch(task, target.key);

    requireCurrentTarget(target.key);
    try {
      await settleCanceledDownloadTask(task, target.key);
      task.startupError = null;
    } catch (error) {
      task.startupError = error;
      throw error;
    }
    tasks.delete(id);

    res.json({ success: true, message: '任务已取消并清理临时文件' });
  } catch (err) {
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'DOWNLOAD_PROCESS_IDENTITY_MISMATCH', 'DOWNLOAD_LAUNCH_AMBIGUOUS'].includes(err.code);
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// 5. Run a Local Model on llama-server (Strict Parameters Validation)
router.post('/run-local', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    await llmLifecycleMutex.run(target.key, async () => {
    const validatedParams = validateModelLaunchParams(req.body);
    const validatedPath = validateModelFilePath(req.body.filePath);

    await stopManagedLlamaServer(target);
    requireCurrentTarget(target.key);

    const runResult = await launchLlamaServer('file', validatedPath, validatedParams, target.key);

    if (!runResult.success) {
      if (runResult.ambiguous) {
        preserveAmbiguousLlamaLaunch(target.key, 'file', validatedPath, validatedParams, runResult);
      }
      return res.status(runResult.ambiguous ? 503 : 500).json({
        success: false,
        error: runResult.stderr || '启动失败',
        retryable: Boolean(runResult.ambiguous)
      });
    }

    activeInstancesByTarget.set(target.key, {
      targetIdentity: target.key,
      isRunning: true,
      source: 'file',
      port: validatedParams.port,
      pid: runResult.pid,
      pidStartTime: runResult.pidStartTime,
      ownershipToken: runResult.ownershipToken,
      runtimeDir: runResult.runtimeDir,
      statePath: runResult.statePath,
      identityPath: runResult.identityPath,
      logPath: runResult.logPath,
      runtime: 'llama.cpp',
      modelPath: validatedPath,
      alias: validatedParams.alias,
      context: validatedParams.ctx,
      launchParams: validatedParams,
      launchedAt: Date.now(),
      launchAmbiguous: false
    });
    requireCurrentTarget(target.key);

    res.json({
      success: true,
      message: `正在载入本地模型: ${validatedParams.alias} (端口: ${validatedParams.port})`,
      data: { modelAlias: validatedParams.alias, port: validatedParams.port }
    });
    });
  } catch (err) {
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'MANAGED_PROCESS_LAUNCH_AMBIGUOUS', 'LLM_LIFECYCLE_BUSY'].includes(err.code);
    res.status(conflict ? 409 : 400).json({ success: false, error: err.message });
  }
});

// 6. Generic Start (File or HF Hub)
router.post('/start', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    await llmLifecycleMutex.run(target.key, async () => {
    const { source = 'file', modelPath } = req.body;
    if (!['file', 'hf'].includes(source)) throw new Error('模型来源仅支持 file 或 hf');
    const validatedParams = validateModelLaunchParams(req.body);

    let validatedModelPath;
    if (source === 'hf') {
      validatedModelPath = validateHfRepoId(modelPath);
    } else {
      validatedModelPath = validateModelFilePath(modelPath);
    }

    await stopManagedLlamaServer(target);
    requireCurrentTarget(target.key);
    const runResult = await launchLlamaServer(source, validatedModelPath, validatedParams, target.key);

    if (!runResult.success) {
      if (runResult.ambiguous) {
        preserveAmbiguousLlamaLaunch(target.key, source, validatedModelPath, validatedParams, runResult);
      }
      return res.status(runResult.ambiguous ? 503 : 500).json({
        success: false,
        error: runResult.stderr || '启动失败',
        retryable: Boolean(runResult.ambiguous)
      });
    }

    activeInstancesByTarget.set(target.key, {
      targetIdentity: target.key,
      isRunning: true,
      source,
      port: validatedParams.port,
      pid: runResult.pid,
      pidStartTime: runResult.pidStartTime,
      ownershipToken: runResult.ownershipToken,
      runtimeDir: runResult.runtimeDir,
      statePath: runResult.statePath,
      identityPath: runResult.identityPath,
      logPath: runResult.logPath,
      runtime: 'llama.cpp',
      modelPath: validatedModelPath,
      alias: validatedParams.alias,
      context: validatedParams.ctx,
      launchParams: validatedParams,
      launchedAt: Date.now(),
      launchAmbiguous: false
    });
    requireCurrentTarget(target.key);

    res.json({
      success: true,
      message: `大模型服务已发送启动指令 (模型: ${validatedParams.alias}, 端口: ${validatedParams.port})`,
      data: { alias: validatedParams.alias, port: validatedParams.port }
    });
    });
  } catch (err) {
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'MANAGED_PROCESS_LAUNCH_AMBIGUOUS', 'LLM_LIFECYCLE_BUSY'].includes(err.code);
    res.status(conflict ? 409 : 400).json({ success: false, error: err.message });
  }
});

// Stop llama-server
router.post('/stop', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    const result = await llmLifecycleMutex.run(target.key, () => stopManagedLlamaServer(target));
    res.json({
      success: true,
      message: result.reason === 'not-managed' ? '当前 SSH 服务器没有由管理器启动的 llama-server' : '已停止 llama-server 推理服务'
    });
  } catch (err) {
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'MANAGED_PROCESS_IDENTITY_MISMATCH', 'MANAGED_PROCESS_LAUNCH_AMBIGUOUS', 'LLM_LIFECYCLE_BUSY'].includes(err.code);
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// Restart llama-server
router.post('/restart', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    await llmLifecycleMutex.run(target.key, async () => {
    const activeInstance = activeInstancesByTarget.peek(target.key);
    if (!activeInstance?.modelPath || !activeInstance.launchParams) {
      return res.status(409).json({ success: false, error: '缺少上次启动参数，请重新选择模型启动' });
    }
    await stopManagedLlamaServer(target);
    requireCurrentTarget(target.key);

    const runResult = await launchLlamaServer(
      activeInstance.source || 'file',
      activeInstance.modelPath,
      activeInstance.launchParams,
      target.key
    );
    if (!runResult.success) {
      if (runResult.ambiguous) {
        preserveAmbiguousLlamaLaunch(
          target.key,
          activeInstance.source || 'file',
          activeInstance.modelPath,
          activeInstance.launchParams,
          runResult
        );
      }
      return res.status(runResult.ambiguous ? 503 : 500).json({
        success: false,
        error: runResult.stderr || '重启失败',
        retryable: Boolean(runResult.ambiguous)
      });
    }
    activeInstance.isRunning = true;
    activeInstance.pid = runResult.pid;
    activeInstance.pidStartTime = runResult.pidStartTime;
    activeInstance.ownershipToken = runResult.ownershipToken;
    activeInstance.runtimeDir = runResult.runtimeDir;
    activeInstance.statePath = runResult.statePath;
    activeInstance.identityPath = runResult.identityPath;
    activeInstance.logPath = runResult.logPath;
    activeInstance.launchedAt = Date.now();
    activeInstance.launchAmbiguous = false;
    requireCurrentTarget(target.key);
    res.json({ success: true, message: '已按原参数重新启动推理模型服务' });
    });
  } catch (err) {
    const conflict = ['SSH_TARGET_CHANGED', 'SSH_TARGET_CHANGING', 'MANAGED_PROCESS_IDENTITY_MISMATCH', 'MANAGED_PROCESS_LAUNCH_AMBIGUOUS', 'LLM_LIFECYCLE_BUSY'].includes(err.code);
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// Get LLM Logs
router.get('/logs', async (req, res) => {
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    const activeInstance = activeInstancesByTarget.peek(target.key);
    if (!activeInstance?.runtimeDir || !activeInstance.logPath) {
      return res.json({ success: true, logs: '暂无运行日志' });
    }
    const runtimeDir = validatePrivateRuntimeDirectory(activeInstance.runtimeDir, 'llama');
    const logPath = validateSafePath(activeInstance.logPath);
    if (path.posix.dirname(logPath) !== runtimeDir) throw new Error('Invalid managed llama log path');
    const result = await executeCommand('tail', ['-n', '100', '--', logPath], { timeoutMs: 4000 });
    requireCurrentTarget(target.key);
    res.json({ success: true, logs: result.stdout || '暂无运行日志' });
  } catch (err) {
    const conflict = err.code === 'SSH_TARGET_CHANGED' || err.code === 'SSH_TARGET_CHANGING';
    res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
  }
});

// SSE Streaming Chat Proxy through the authenticated SSH connection
router.post('/chat', async (req, res) => {
  let tunnel = null;
  try {
    const target = requireCurrentTarget();
    await ensureManagedStateRecovered(target);
    const activeInstance = activeInstancesByTarget.peek(target.key);
    if (!activeInstance?.pid || !activeInstance.isRunning) {
      return res.status(409).json({ success: false, error: '当前 SSH 服务器没有正在运行的托管模型' });
    }
    const managedStatus = await inspectManagedLlamaProcess(activeInstance, target.key);
    requireCurrentTarget(target.key);
    if (managedStatus !== 'running') {
      activeInstance.isRunning = false;
      return res.status(409).json({ success: false, error: '托管模型进程已退出或身份校验失败' });
    }
    const targetPort = activeInstance.port || 8080;
    const payload = JSON.stringify(req.body);
    tunnel = await createForwardedConnection('127.0.0.1', targetPort);

    const tunnelAgent = new http.Agent({ keepAlive: false });
    // An ssh2 Channel is already connected when it reaches the HTTP agent. If
    // it is returned synchronously, Node 24 can observe an immediate channel
    // end inside http.request(), before callers have a chance to attach the
    // ClientRequest error handler. Hand the socket to the agent on the next
    // microtask so request-level guards are installed first.
    attachConnectedSocketToAgent(tunnelAgent, tunnel);

    const options = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: '/v1/chat/completions',
      method: 'POST',
      agent: tunnelAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
    }

    let proxyIdleTimer = null;
    const clearProxyIdleTimer = () => {
      if (proxyIdleTimer) clearTimeout(proxyIdleTimer);
      proxyIdleTimer = null;
    };
    const armProxyIdleTimer = () => {
      clearProxyIdleTimer();
      proxyIdleTimer = setTimeout(() => {
        proxyReq.destroy(new Error('llama-server 请求超时'));
      }, 120000);
      proxyIdleTimer.unref?.();
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      if (!req.body.stream && proxyRes.headers['content-type']) {
        res.setHeader('Content-Type', proxyRes.headers['content-type']);
      }
      proxyRes.on('error', () => {
        clearProxyIdleTimer();
        try { tunnel?.destroy(); } catch (_) {}
      });
      proxyRes.on('data', armProxyIdleTimer);
      proxyRes.on('end', () => {
        clearProxyIdleTimer();
        try { tunnel?.destroy(); } catch (_) {}
      });
      proxyRes.pipe(res);
    });
    res.on('close', () => {
      clearProxyIdleTimer();
      if (!proxyReq.destroyed) proxyReq.destroy();
      try { tunnel?.destroy(); } catch (_) {}
      tunnelAgent.destroy();
    });

    proxyReq.on('error', (err) => {
      clearProxyIdleTimer();
      try { tunnel?.destroy(); } catch (_) {}
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: `无法通过 SSH 连接 llama-server 端口 ${targetPort} (${err.message})` });
      } else {
        res.end();
      }
    });
    proxyReq.on('close', clearProxyIdleTimer);
    req.on('aborted', () => {
      proxyReq.destroy();
      try { tunnel?.destroy(); } catch (_) {}
    });

    armProxyIdleTimer();
    proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    try { tunnel?.destroy(); } catch (_) {}
    if (!res.headersSent) {
      const conflict = err.code === 'SSH_TARGET_CHANGED' || err.code === 'SSH_TARGET_CHANGING';
      res.status(conflict ? 409 : 500).json({ success: false, error: err.message });
    }
  }
});

export default router;
