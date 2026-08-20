import { Router } from 'express';
import { executeCommand, executeRawScript } from '../sshManager.js';
import { getConfig } from '../config.js';

const router = Router();

const PRESET_SCRIPTS = [
  {
    id: 'clean-cache',
    title: '清理系统内存与日志缓存',
    description: '释放系统 PageCache / Dentry / Inode 缓存，清理 3 天前的 systemd 日志',
    command: 'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true; journalctl --vacuum-time=3d 2>/dev/null || true; echo "缓存清理完成"'
  },
  {
    id: 'check-ports',
    title: '查看所有网络监听端口',
    description: '检查本机正在监听的 TCP / UDP 端口及对应进程',
    command: 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null'
  },
  {
    id: 'system-journal',
    title: '查看系统最新关键日志',
    description: '获取 systemd 最近 80 条系统级报错与事件日志',
    command: 'journalctl -xe --no-pager -n 80 2>/dev/null || tail -n 80 /var/log/messages 2>/dev/null || tail -n 80 /var/log/syslog 2>/dev/null'
  },
  {
    id: 'disk-top',
    title: '查找占用磁盘最大的前 15 个目录',
    description: '扫描根目录下占用空间最大的目录 (只扫描一级)',
    command: 'du -ahx / 2>/dev/null | sort -rh | head -n 15'
  },
  {
    id: 'docker-prune',
    title: 'Docker 垃圾清理 (Prune)',
    description: '清理所有已停止的容器、未使用的网络和虚悬镜像',
    command: 'docker system prune -f 2>/dev/null || echo "Docker 未运行"'
  },
  {
    id: 'network-info',
    title: '网络与公网 IP 诊断',
    description: '检测本机的路由网关、DNS 解析及对外公网 IP',
    command: 'ip route 2>/dev/null; echo ""; echo "--- Public IP ---"; curl -m 5 -s https://api.ipify.org 2>/dev/null || curl -m 5 -s https://ifconfig.me 2>/dev/null || echo "无法获取公网 IP"'
  }
];

// 1. Get list of preset scripts & whether custom scripts are enabled
router.get('/presets', (req, res) => {
  const cfg = getConfig();
  res.json({
    success: true,
    presets: PRESET_SCRIPTS,
    customScriptsEnabled: Boolean(cfg.enableCustomScripts)
  });
});

// 2. Run script (preset or custom)
router.post('/run', async (req, res) => {
  try {
    const { scriptId, customCommand } = req.body;

    if (scriptId) {
      const preset = PRESET_SCRIPTS.find(s => s.id === scriptId);
      if (!preset) {
        return res.status(404).json({ success: false, error: '未找到指定的预设脚本' });
      }

      const result = await executeCommand('sh', ['-c', preset.command], { timeoutMs: 30000 });
      return res.json({
        success: true,
        command: preset.command,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        executedAt: new Date().toISOString()
      });
    }

    if (customCommand) {
      const cfg = getConfig();
      if (!cfg.enableCustomScripts) {
        return res.status(403).json({
          success: false,
          error: '安全限制：当前部署已默认禁用任意自定义 Shell 脚本执行功能。如需启用，请在服务端环境变量中显式配置 ENABLE_CUSTOM_SCRIPTS=true。'
        });
      }

      const cmdToRun = String(customCommand).trim();
      if (!cmdToRun) {
        return res.status(400).json({ success: false, error: '执行的指令不能为空' });
      }

      const result = await executeRawScript(cmdToRun, { timeoutMs: 30000 });
      return res.json({
        success: true,
        command: cmdToRun,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        executedAt: new Date().toISOString()
      });
    }

    return res.status(400).json({ success: false, error: '缺少 scriptId 或 customCommand 参数' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
