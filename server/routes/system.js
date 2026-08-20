import { Router } from 'express';
import { executeCommand, getConnectionStatus } from '../sshManager.js';
import { metricsCollector } from '../metricsCollector.js';

const router = Router();

export async function fetchSystemOverview() {
  const status = getConnectionStatus();
  if (!status.connected) {
    throw new Error('未连接到远程服务器');
  }

  const snapshot = metricsCollector.getSnapshot();
  if (snapshot) return snapshot;

  return await metricsCollector.collect();
}

// REST Endpoints
router.get('/metrics', async (req, res) => {
  try {
    const metrics = await fetchSystemOverview();
    res.json({ success: true, data: metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dynamic GPU detection endpoint (multi-GPU supported)
router.get('/gpus', async (req, res) => {
  try {
    const { detectGpus } = await import('../gpuDetector.js');
    const gpuInfo = await detectGpus(req.query.refresh === 'true');
    res.json({ success: true, data: gpuInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Listening ports endpoint
router.get('/ports', async (req, res) => {
  try {
    const result = await executeCommand('ss', ['-tulpn'], { timeoutMs: 5000 });
    const lines = (result.stdout || '').split('\n').filter(Boolean);
    const ports = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        ports.push({
          proto: parts[0],
          state: parts[1] || 'LISTEN',
          localAddress: parts[4] || parts[3],
          process: parts.slice(5).join(' ') || '-'
        });
      }
    }

    res.json({ success: true, ports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
