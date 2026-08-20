import { Router } from 'express';
import { executeCommand } from '../sshManager.js';
import { validateDockerAction, validateDockerIdentifier } from '../executor.js';

const router = Router();

// 1. Check if Docker is installed & running
router.get('/status', async (req, res) => {
  try {
    const versionRes = await executeCommand('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
    const isInstalled = versionRes.success && Boolean(versionRes.stdout.trim());

    res.json({
      success: true,
      installed: isInstalled,
      version: versionRes.stdout.trim() || null,
      error: isInstalled ? null : 'Docker 未安装或 Docker 服务未运行'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. List all containers with stats
router.get('/containers', async (req, res) => {
  try {
    const psRes = await executeCommand('docker', ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: 8000 });
    if (!psRes.success) {
      return res.status(400).json({ success: false, error: psRes.stderr || '获取 Docker 容器列表失败' });
    }

    const rawPsLines = psRes.stdout.trim().split('\n').filter(Boolean);
    const containers = [];

    for (const line of rawPsLines) {
      try {
        const item = JSON.parse(line);
        containers.push({
          id: item.ID,
          names: item.Names,
          image: item.Image,
          command: item.Command,
          created: item.CreatedAt || item.RunningFor,
          status: item.Status,
          state: item.State,
          ports: item.Ports,
          isRunning: (item.State || '').toLowerCase().includes('running') || (item.Status || '').toLowerCase().startsWith('up')
        });
      } catch (_) {}
    }

    let statsMap = {};
    if (containers.length > 0) {
      const statsRes = await executeCommand('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeoutMs: 6000 });
      if (statsRes.success) {
        const statLines = statsRes.stdout.trim().split('\n').filter(Boolean);
        for (const sLine of statLines) {
          try {
            const s = JSON.parse(sLine);
            statsMap[s.ID] = {
              cpuPerc: s.CPUPerc,
              memUsage: s.MemUsage,
              memPerc: s.MemPerc,
              netIO: s.NetIO,
              blockIO: s.BlockIO
            };
          } catch (_) {}
        }
      }
    }

    const result = containers.map(c => ({
      ...c,
      stats: statsMap[c.id] || null
    }));

    res.json({ success: true, containers: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Container actions (start, stop, restart, kill, pause, unpause, rm)
router.post('/containers/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const validatedId = validateDockerIdentifier(id);
    const validatedAction = validateDockerAction(action);

    let args = [validatedAction, validatedId];
    if (validatedAction === 'rm') {
      args = ['rm', '-f', validatedId];
    }

    const result = await executeCommand('docker', args, { timeoutMs: 15000 });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || `执行 ${validatedAction} 失败` });
    }

    res.json({ success: true, message: `容器已成功执行 ${validatedAction}` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Get container logs
router.get('/containers/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 10), 2000);
    const validatedId = validateDockerIdentifier(id);

    const result = await executeCommand('docker', ['logs', '--tail', String(tail), validatedId], { timeoutMs: 8000 });
    const output = (result.stdout || '') + (result.stderr || '');

    res.json({
      success: true,
      logs: output || '无日志输出'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 5. List Docker Images
router.get('/images', async (req, res) => {
  try {
    const imgRes = await executeCommand('docker', ['images', '--format', '{{json .}}'], { timeoutMs: 8000 });
    if (!imgRes.success) {
      return res.status(400).json({ success: false, error: imgRes.stderr || '获取 Docker 镜像失败' });
    }

    const lines = imgRes.stdout.trim().split('\n').filter(Boolean);
    const images = [];
    for (const l of lines) {
      try {
        const item = JSON.parse(l);
        images.push({
          repository: item.Repository,
          tag: item.Tag,
          id: item.ID,
          createdSince: item.CreatedSince,
          size: item.Size
        });
      } catch (_) {}
    }

    res.json({ success: true, images });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Pull Docker Image
router.post('/images/pull', async (req, res) => {
  try {
    const { imageName } = req.body;
    if (!imageName || typeof imageName !== 'string') {
      return res.status(400).json({ success: false, error: '镜像名称不能为空' });
    }

    const validatedImage = validateDockerIdentifier(imageName);
    const result = await executeCommand('docker', ['pull', validatedImage], { timeoutMs: 120000 });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '拉取镜像失败' });
    }

    res.json({ success: true, message: `镜像 ${validatedImage} 拉取成功`, output: result.stdout });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 7. Delete Docker Image
router.post('/images/delete', async (req, res) => {
  try {
    const { imageId, force } = req.body;
    if (!imageId || typeof imageId !== 'string') {
      return res.status(400).json({ success: false, error: '镜像 ID 不能为空' });
    }

    const validatedImageId = validateDockerIdentifier(imageId);
    const args = ['rmi'];
    if (force) args.push('-f');
    args.push(validatedImageId);

    const result = await executeCommand('docker', args, { timeoutMs: 15000 });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '删除镜像失败' });
    }

    res.json({ success: true, message: '镜像已成功删除' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
