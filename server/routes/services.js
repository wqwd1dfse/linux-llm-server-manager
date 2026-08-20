import { Router } from 'express';
import { executeCommand } from '../sshManager.js';
import {
  validateSystemdAction,
  validateServiceName,
  validatePid,
  validateSignal
} from '../executor.js';

const router = Router();

// 1. List processes
router.get('/processes', async (req, res) => {
  try {
    const sortBy = req.query.sort === 'mem' ? '-%mem' : '-%cpu';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 5), 200);

    const result = await executeCommand('ps', [
      '-eo', 'pid,user,%cpu,%mem,stat,start,time,comm,args',
      `--sort=${sortBy}`
    ], { timeoutMs: 5000 });

    if (!result.success && !result.stdout) {
      return res.status(400).json({ success: false, error: result.stderr || '获取进程列表失败' });
    }

    const lines = result.stdout.trim().split('\n').slice(0, limit + 1);
    const processes = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts.length >= 8) {
        const pid = parseInt(parts[0], 10);
        const user = parts[1];
        const cpu = parseFloat(parts[2]) || 0;
        const mem = parseFloat(parts[3]) || 0;
        const stat = parts[4];
        const start = parts[5];
        const time = parts[6];
        const command = parts[7];
        const args = parts.slice(8).join(' ') || command;

        processes.push({
          pid,
          user,
          cpu,
          mem,
          stat,
          start,
          time,
          command,
          args
        });
      }
    }

    res.json({ success: true, processes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Kill process with strict validation
router.post('/processes/kill', async (req, res) => {
  try {
    const { pid, signal = '9' } = req.body;
    const validatedPid = validatePid(pid);
    const validatedSig = validateSignal(signal);

    const result = await executeCommand('kill', [`-${validatedSig}`, String(validatedPid)], { timeoutMs: 5000 });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || `终止进程 ${validatedPid} 失败` });
    }

    res.json({ success: true, message: `进程 PID ${validatedPid} 已成功终止` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. List Systemd Services
router.get('/systemd', async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const args = ['list-units', '--type=service', '--no-pager', '--no-legend'];
    if (filter === 'running') {
      args.push('--state=running');
    } else if (filter === 'failed') {
      args.push('--state=failed');
    } else {
      args.push('--all');
    }

    const result = await executeCommand('systemctl', args, { timeoutMs: 8000 });
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    const services = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const unit = parts[0].replace(/\.service$/, '');
        const load = parts[1];
        const active = parts[2];
        const sub = parts[3];
        const description = parts.slice(4).join(' ');

        services.push({
          name: unit,
          fullName: parts[0],
          load,
          active,
          sub,
          description,
          isRunning: active === 'active' && sub === 'running'
        });
      }
    }

    res.json({ success: true, services });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Control Systemd Service
router.post('/systemd/control', async (req, res) => {
  try {
    const { name, action } = req.body;
    const validatedAction = validateSystemdAction(action);
    const validatedServiceName = validateServiceName(name);

    const result = await executeCommand('systemctl', [validatedAction, validatedServiceName], { timeoutMs: 12000 });

    if (validatedAction === 'status') {
      return res.json({
        success: true,
        output: result.stdout || result.stderr
      });
    }

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || `执行 ${validatedAction} 失败` });
    }

    res.json({ success: true, message: `服务 ${name} 已成功执行 ${validatedAction}` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
