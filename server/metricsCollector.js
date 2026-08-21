import { executeCommand, getConnectionStatus } from './sshManager.js';
import { getConfig } from './config.js';

class MetricsCollector {
  constructor() {
    this.latestSnapshot = null;
    this.history = [];
    this.maxHistoryLength = 1200; // 60 minutes @ 3s
    this.isCollecting = false;
    this.timer = null;
    this.listeners = new Set();
    this.lastNetStats = { time: 0, rx: 0, tx: 0 };
    this.lastDiskStats = { time: 0, readBytes: 0, writeBytes: 0 };
    this.lastCpuStats = { time: 0, idle: 0, total: 0 };
  }

  start() {
    if (this.timer) return;
    this.scheduleNext(100);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext(delayMs = null) {
    if (this.timer) clearTimeout(this.timer);
    const interval = delayMs !== null ? delayMs : (getConfig().metricsInterval || 2000);
    this.timer = setTimeout(async () => {
      try {
        await this.collect();
      } catch (err) {
        // SSH disconnection is a normal transient state — suppress expected errors
        const msg = err?.message || String(err);
        const isExpected = msg.includes('Not connected') || msg.includes('connect') || msg.includes('ECONNREFUSED');
        if (!isExpected) {
          console.error('[MetricsCollector] Unexpected collection error:', msg);
        }
      } finally {
        this.scheduleNext();
      }
    }, interval);
  }

  addListener(fn) {
    this.listeners.add(fn);
  }

  removeListener(fn) {
    this.listeners.delete(fn);
  }

  getSnapshot() {
    return this.latestSnapshot;
  }

  getHistory(range = '5m') {
    const now = Date.now();
    let durationMs = 5 * 60 * 1000;
    let targetVisualPoints = 120;

    if (range === '30m') {
      durationMs = 30 * 60 * 1000;
    } else if (range === '60m') {
      durationMs = 60 * 60 * 1000;
    }

    const cutoff = now - durationMs;
    const points = this.history.filter(p => p.t >= cutoff);

    let visualPoints = points;
    if (points.length > targetVisualPoints) {
      const step = Math.ceil(points.length / targetVisualPoints);
      visualPoints = points.filter((_, i) => i % step === 0);
    }

    const calcStats = (arr, key) => {
      const valid = arr.map(p => p[key]).filter(v => typeof v === 'number' && !isNaN(v) && v !== null);
      if (!valid.length) return { min: null, max: null, avg: null, current: null, status: 'unavailable' };
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const avg = parseFloat((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1));
      const current = valid[valid.length - 1];
      return { min, max, avg, current, status: 'available' };
    };

    return {
      range,
      durationMs,
      count: visualPoints.length,
      points: visualPoints,
      stats: {
        cpu: calcStats(points, 'cpu'),
        gpuJunction: calcStats(points, 'gpuJ'),
        gpuEdge: calcStats(points, 'gpuE'),
        gpuPower: calcStats(points, 'gpuP'),
        fanRpm: calcStats(points, 'fanRpm')
      }
    };
  }

  async collect() {
    if (this.isCollecting) return this.latestSnapshot;

    const status = getConnectionStatus();
    if (!status.connected) {
      this.latestSnapshot = null;
      return null;
    }

    this.isCollecting = true;
    try {
      const script = `
        echo "---SYSINFO---"
        hostname
        uname -r
        uname -m
        cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|NAME|VERSION)=' || echo "NAME=Linux"
        cat /proc/uptime

        echo "---CPU---"
        cat /proc/loadavg
        cat /proc/cpuinfo | grep -E '^(model name|cpu cores|processor|cpu MHz|cache size)'

        CPU_A=($(grep '^cpu ' /proc/stat 2>/dev/null))
        sleep 0.2
        CPU_B=($(grep '^cpu ' /proc/stat 2>/dev/null))
        IDLE_A=$(( \${CPU_A[4]} + \${CPU_A[5]} ))
        IDLE_B=$(( \${CPU_B[4]} + \${CPU_B[5]} ))
        TOT_A=0; for x in "\${CPU_A[@]:1}"; do TOT_A=$(( TOT_A + x )); done
        TOT_B=0; for x in "\${CPU_B[@]:1}"; do TOT_B=$(( TOT_B + x )); done
        D_IDLE=$(( IDLE_B - IDLE_A ))
        D_TOT=$(( TOT_B - TOT_A ))
        if [ $D_TOT -gt 0 ]; then
          CPU_PCT=$(( (1000 * (D_TOT - D_IDLE)) / D_TOT ))
          echo "CPU_MEASURED: $CPU_PCT"
        else
          echo "CPU_MEASURED: 0"
        fi
        cat /proc/stat | grep -E '^cpu[0-9]+ '

        echo "---MEM---"
        cat /proc/meminfo

        echo "---DISK---"
        df -B1 -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -B1 -P
        echo "---DISK_INODES---"
        df -i -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -i -P
        echo "---DISKSTATS---"
        cat /proc/diskstats 2>/dev/null || true

        echo "---NET---"
        cat /proc/net/dev

        echo "---GPU---"
        if command -v nvidia-smi >/dev/null 2>&1; then
          nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw --format=csv,noheader,nounits 2>/dev/null || echo "NO_NVIDIA"
        else
          echo "NO_NVIDIA"
        fi
        for dev in /sys/class/drm/card[0-9]/device; do
          if [ -d "$dev" ] && [ -f "$dev/gpu_busy_percent" -o -f "$dev/mem_info_vram_used" ]; then
            echo "AMD_SYSFS_GPU:"
            echo "BUSY: $(cat $dev/gpu_busy_percent 2>/dev/null || echo '')"
            echo "TEMP: $(cat $dev/hwmon/hwmon*/temp1_input 2>/dev/null | head -n 1 || echo '')"
            echo "VRAM_USED: $(cat $dev/mem_info_vram_used 2>/dev/null || echo '')"
            echo "VRAM_TOTAL: $(cat $dev/mem_info_vram_total 2>/dev/null || echo '')"
            echo "POWER: $(cat $dev/hwmon/hwmon*/power1_average 2>/dev/null | head -n 1 || echo '')"
          fi
        done
        lspci 2>/dev/null | grep -i -E 'vga|3d|display' || echo "NO_PCI_DISPLAY"

        echo "---TOP_CPU_MEM---"
        ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 10
      `;

      const result = await executeCommand('sh', ['-c', script], { timeoutMs: 8000 });
      if (!result.success && !result.stdout) {
        throw new Error(result.stderr || '指标采集命令执行失败');
      }

      const parsed = this.parseSystemOutput(result.stdout);
      this.latestSnapshot = parsed;

      // Record real timestamped sample to history
      const now = Date.now();
      const primaryGpu = parsed.gpu?.devices?.[0];
      this.history.push({
        t: now,
        cpu: parsed.cpu?.usagePercent !== undefined ? parsed.cpu.usagePercent : null,
        gpuJ: primaryGpu?.temperature !== undefined ? primaryGpu.temperature : null,
        gpuE: primaryGpu?.tempEdge !== undefined ? primaryGpu.tempEdge : null,
        gpuP: primaryGpu?.powerDraw ? parseFloat(primaryGpu.powerDraw) || null : null,
        fanRpm: null, // Populated by fan status if queried
        cpuPwm: null
      });

      if (this.history.length > this.maxHistoryLength) {
        this.history.shift();
      }

      // Notify listeners (WebSockets)
      for (const listener of this.listeners) {
        try {
          listener(parsed);
        } catch (_) {}
      }

      return parsed;
    } finally {
      this.isCollecting = false;
    }
  }

  parseSystemOutput(raw) {
    const sections = {};
    const lines = (raw || '').split('\n');
    let currentSection = 'HEADER';
    sections[currentSection] = [];

    for (const line of lines) {
      if (line.startsWith('---') && line.endsWith('---')) {
        currentSection = line.replace(/---/g, '').trim();
        sections[currentSection] = [];
      } else {
        sections[currentSection].push(line);
      }
    }

    // Parse OS & Hostname
    const sysLines = (sections['SYSINFO'] || []).filter(l => l.trim().length > 0);
    const hostname = sysLines[0] || 'Unknown';
    const kernel = sysLines[1] || '';
    const arch = sysLines[2] || '';

    let osName = 'Linux';
    for (const l of sysLines) {
      if (l.startsWith('PRETTY_NAME=')) {
        osName = l.replace('PRETTY_NAME=', '').replace(/"/g, '');
        break;
      }
    }

    const uptimeLine = sysLines[sysLines.length - 1] || '0 0';
    const uptimeSeconds = parseFloat(uptimeLine.split(' ')[0]) || 0;

    // Parse CPU
    const cpuLines = sections['CPU'] || [];
    const loadavgLine = cpuLines.find(l => /^[0-9.]+ [0-9.]+ [0-9.]+/.test(l.trim())) || '0 0 0';
    const loadParts = loadavgLine.trim().split(/\s+/);
    const loadavg = [parseFloat(loadParts[0]) || 0, parseFloat(loadParts[1]) || 0, parseFloat(loadParts[2]) || 0];

    let cpuModel = 'Standard CPU';
    let cpuCores = 1;
    let cpuMhz = 'N/A';
    let cpuCache = 'N/A';

    const coreCount = cpuLines.filter(l => l.startsWith('processor')).length;
    if (coreCount > 0) cpuCores = coreCount;

    const modelLine = cpuLines.find(l => l.startsWith('model name'));
    if (modelLine) {
      cpuModel = modelLine.split(':')[1]?.trim() || cpuModel;
    }

    const mhzLine = cpuLines.find(l => l.startsWith('cpu MHz'));
    if (mhzLine) {
      const mhzVal = parseFloat(mhzLine.split(':')[1]?.trim() || 0);
      cpuMhz = mhzVal >= 1000 ? `${(mhzVal / 1000).toFixed(2)} GHz` : `${mhzVal.toFixed(0)} MHz`;
    }

    const cacheLine = cpuLines.find(l => l.startsWith('cache size'));
    if (cacheLine) {
      cpuCache = cacheLine.split(':')[1]?.trim() || cpuCache;
    }

    let cpuUsagePercent = 0;
    const measuredLine = cpuLines.find(l => l.startsWith('CPU_MEASURED:'));
    if (measuredLine) {
      const rawVal = parseInt(measuredLine.replace('CPU_MEASURED:', '').trim(), 10) || 0;
      cpuUsagePercent = Math.max(0, Math.min(100, Math.round(rawVal / 10)));
    } else {
      cpuUsagePercent = Math.min(100, Math.round((loadavg[0] / Math.max(cpuCores, 1)) * 100));
    }

    const perCoreLines = cpuLines.filter(l => /^cpu[0-9]+ /.test(l));
    const perCoreCount = perCoreLines.length || cpuCores;

    // Parse Memory
    const meminfoLines = sections['MEM'] || [];
    const memMap = {};
    for (const line of meminfoLines) {
      const p = line.split(':');
      if (p.length === 2) {
        const key = p[0].trim();
        const valKb = parseInt(p[1].trim().split(/\s+/)[0], 10) || 0;
        memMap[key] = valKb * 1024;
      }
    }

    const memTotal = memMap['MemTotal'] || 0;
    const memFree = memMap['MemFree'] || 0;
    const memAvailable = memMap['MemAvailable'] !== undefined ? memMap['MemAvailable'] : (memFree + (memMap['Buffers'] || 0) + (memMap['Cached'] || 0));
    const memBuffers = memMap['Buffers'] || 0;
    const memCached = memMap['Cached'] || 0;
    const memSlab = memMap['Slab'] || 0;
    const memUsedActual = memTotal > 0 ? (memTotal - memAvailable) : 0;
    const swapTotal = memMap['SwapTotal'] || 0;
    const swapFree = memMap['SwapFree'] || 0;
    const swapUsed = swapTotal > 0 ? (swapTotal - swapFree) : 0;

    const memPercent = memTotal > 0 ? Math.round((memUsedActual / memTotal) * 1000) / 10 : 0;
    const swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0;

    // Parse Disks & Inodes
    const diskLines = sections['DISK'] || [];
    const inodeLines = sections['DISK_INODES'] || [];
    const inodeMap = {};

    for (let i = 1; i < inodeLines.length; i++) {
      const parts = inodeLines[i].trim().split(/\s+/);
      if (parts.length >= 6) {
        inodeMap[parts[5]] = {
          total: parseInt(parts[1], 10) || 0,
          used: parseInt(parts[2], 10) || 0,
          free: parseInt(parts[3], 10) || 0,
          percent: parts[4] || '0%'
        };
      }
    }

    const disks = [];
    let diskTotalSum = 0;
    let diskUsedSum = 0;

    for (let i = 1; i < diskLines.length; i++) {
      const line = diskLines[i].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        const filesystem = parts[0];
        const size = parseInt(parts[1], 10) || 0;
        const used = parseInt(parts[2], 10) || 0;
        const avail = parseInt(parts[3], 10) || 0;
        const mount = parts[5];

        if (size > 0 && (filesystem.startsWith('/dev/') || mount === '/' || filesystem.includes('sd') || filesystem.includes('nvme'))) {
          const inodes = inodeMap[mount] || { total: 0, used: 0, percent: '0%' };
          disks.push({
            filesystem,
            mount,
            total: size,
            used,
            available: avail,
            percent: Math.round((used / size) * 100),
            inodes
          });
          diskTotalSum += size;
          diskUsedSum += used;
        }
      }
    }

    const overallDiskPercent = diskTotalSum > 0 ? Math.round((diskUsedSum / diskTotalSum) * 1000) / 10 : 0;

    // Disk I/O Speeds
    const diskstatLines = sections['DISKSTATS'] || [];
    let totalReadSectors = 0;
    let totalWriteSectors = 0;

    for (const line of diskstatLines) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 14) {
        const devName = p[2];
        if (/^(sd[a-z]|nvme[0-9]+n[0-9]+|vd[a-z]|hd[a-z])$/.test(devName)) {
          totalReadSectors += parseInt(p[5], 10) || 0;
          totalWriteSectors += parseInt(p[9], 10) || 0;
        }
      }
    }

    const totalReadBytes = totalReadSectors * 512;
    const totalWriteBytes = totalWriteSectors * 512;
    const now = Date.now();
    let diskReadSpeed = 0;
    let diskWriteSpeed = 0;

    if (this.lastDiskStats.time > 0 && now > this.lastDiskStats.time) {
      const deltaSec = (now - this.lastDiskStats.time) / 1000;
      if (deltaSec > 0) {
        diskReadSpeed = Math.max(0, Math.round((totalReadBytes - this.lastDiskStats.readBytes) / deltaSec));
        diskWriteSpeed = Math.max(0, Math.round((totalWriteBytes - this.lastDiskStats.writeBytes) / deltaSec));
      }
    }
    this.lastDiskStats = { time: now, readBytes: totalReadBytes, writeBytes: totalWriteBytes };

    // Parse Network Speeds
    const netLines = sections['NET'] || [];
    let totalRxBytes = 0;
    let totalTxBytes = 0;
    const interfaces = [];

    for (const line of netLines) {
      if (line.includes(':')) {
        const [ifaceRaw, dataRaw] = line.split(':');
        const iface = ifaceRaw.trim();
        const parts = dataRaw.trim().split(/\s+/).map(Number);
        if (parts.length >= 9) {
          const rx = parts[0] || 0;
          const tx = parts[8] || 0;
          if (iface !== 'lo') {
            totalRxBytes += rx;
            totalTxBytes += tx;
            interfaces.push({ iface, rx, tx });
          }
        }
      }
    }

    let rxSpeed = 0;
    let txSpeed = 0;
    if (this.lastNetStats.time > 0 && now > this.lastNetStats.time) {
      const deltaSec = (now - this.lastNetStats.time) / 1000;
      if (deltaSec > 0) {
        rxSpeed = Math.max(0, Math.round((totalRxBytes - this.lastNetStats.rx) / deltaSec));
        txSpeed = Math.max(0, Math.round((totalTxBytes - this.lastNetStats.tx) / deltaSec));
      }
    }
    this.lastNetStats = { time: now, rx: totalRxBytes, tx: totalTxBytes };

    // Parse GPU
    const gpuLines = (sections['GPU'] || []).filter(Boolean);
    const gpus = [];
    let gpuType = 'none';

    const hasNvidia = gpuLines.some(l => !l.includes('NO_NVIDIA') && l.includes(','));
    if (hasNvidia) {
      gpuType = 'nvidia';
      for (const line of gpuLines) {
        if (line.includes('NO_') || line.includes('AMD_') || line.includes('BUSY:') || line.includes('TEMP:') || line.includes('VRAM_') || line.includes('POWER:')) continue;
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= 8) {
          gpus.push({
            index: parts[0],
            name: parts[1],
            driverVersion: parts[2],
            temperature: parseFloat(parts[3]) || null,
            utilizationGpu: parseFloat(parts[4]) || 0,
            utilizationMemory: parseFloat(parts[5]) || 0,
            memoryTotalMb: parseFloat(parts[6]) || 0,
            memoryUsedMb: parseFloat(parts[7]) || 0,
            memoryFreeMb: parseFloat(parts[8]) || 0,
            powerDraw: parts[9] ? `${parts[9]} W` : 'N/A',
            isDedicated: true,
            vendor: 'NVIDIA'
          });
        }
      }
    }

    const hasAmdSysfs = gpuLines.some(l => l.includes('AMD_SYSFS_GPU'));
    const pciLines = gpuLines.filter(l => !l.includes('NO_NVIDIA') && !l.includes('NO_PCI_DISPLAY') && !l.startsWith('AMD_') && !l.startsWith('BUSY:') && !l.startsWith('TEMP:') && !l.startsWith('VRAM_') && !l.startsWith('POWER:'));

    if (hasAmdSysfs) {
      gpuType = 'amd';
      let busy = 0;
      let temp = null;
      let vramUsed = 0;
      let vramTotal = 0;
      let power = 'N/A';

      for (const l of gpuLines) {
        if (l.startsWith('BUSY:')) {
          const val = l.replace('BUSY:', '').trim();
          busy = val ? parseFloat(val) : 0;
        }
        if (l.startsWith('TEMP:')) {
          const val = l.replace('TEMP:', '').trim();
          if (val) {
            const rawTemp = parseFloat(val);
            temp = rawTemp > 1000 ? Math.round(rawTemp / 1000) : rawTemp;
          }
        }
        if (l.startsWith('VRAM_USED:')) {
          const val = l.replace('VRAM_USED:', '').trim();
          if (val) vramUsed = Math.round(parseFloat(val) / 1024 / 1024);
        }
        if (l.startsWith('VRAM_TOTAL:')) {
          const val = l.replace('VRAM_TOTAL:', '').trim();
          if (val) vramTotal = Math.round(parseFloat(val) / 1024 / 1024);
        }
        if (l.startsWith('POWER:')) {
          const val = l.replace('POWER:', '').trim();
          if (val) {
            const microwatts = parseFloat(val) || 0;
            if (microwatts > 0) power = `${(microwatts / 1000000).toFixed(1)} W`;
          }
        }
      }

      let pciName = 'AMD GPU';
      if (pciLines.length > 0) {
        pciName = pciLines[0].replace(/^[0-9a-f:.]+\s+(VGA compatible controller|3D controller|Display controller):\s*/i, '').trim();
      }
      if (/MI50|Vega 20|Pro VII/i.test(pciName)) pciName = 'AMD GPU';

      const vramPercent = vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0;

      gpus.push({
        index: 0,
        name: pciName,
        driverVersion: 'AMD ROCm / AMDGPU Kernel Driver',
        temperature: temp,
        utilizationGpu: busy,
        utilizationMemory: vramPercent,
        memoryTotalMb: vramTotal,
        memoryUsedMb: vramUsed,
        memoryFreeMb: Math.max(0, vramTotal - vramUsed),
        powerDraw: power,
        isDedicated: true,
        vendor: 'AMD'
      });
    }

    if (gpus.length === 0 && pciLines.length > 0) {
      gpuType = 'integrated_or_virtual';
      pciLines.forEach((pci, idx) => {
        let cleanName = pci.replace(/^[0-9a-f:.]+\s+(VGA compatible controller|3D controller|Display controller):\s*/i, '').trim();
        gpus.push({
          index: idx,
          name: cleanName || '通用图形显示设备 (GPU / Display Adapter)',
          driverVersion: 'Linux DRM / Kernel 内核驱动',
          temperature: null,
          utilizationGpu: 0,
          utilizationMemory: 0,
          memoryTotalMb: 0,
          memoryUsedMb: 0,
          memoryFreeMb: 0,
          isDedicated: false,
          note: '集成显卡 / 虚拟机显示适配器',
          vendor: 'Generic'
        });
      });
    }

    // Top Processes
    const topProcesses = [];
    const topLines = sections['TOP_CPU_MEM'] || [];
    for (let i = 1; i < topLines.length; i++) {
      const p = topLines[i].trim().split(/\s+/);
      if (p.length >= 5) {
        topProcesses.push({
          pid: p[0],
          user: p[1],
          cpu: parseFloat(p[2]) || 0,
          mem: parseFloat(p[3]) || 0,
          command: p.slice(4).join(' ')
        });
      }
    }

    return {
      timestamp: new Date().toISOString(),
      os: {
        hostname,
        name: osName,
        kernel,
        arch,
        uptimeSeconds,
        uptimeFormatted: formatUptime(uptimeSeconds)
      },
      cpu: {
        model: cpuModel,
        cores: perCoreCount,
        frequency: cpuMhz,
        cache: cpuCache,
        usagePercent: cpuUsagePercent,
        loadavg
      },
      memory: {
        total: memTotal,
        used: memUsedActual,
        free: memFree,
        available: memAvailable,
        buffers: memBuffers,
        cached: memCached,
        slab: memSlab,
        usagePercent: memPercent,
        swapTotal,
        swapUsed,
        swapPercent
      },
      disk: {
        overallPercent: overallDiskPercent,
        total: diskTotalSum,
        used: diskUsedSum,
        readSpeed: diskReadSpeed,
        writeSpeed: diskWriteSpeed,
        partitions: disks
      },
      gpu: {
        type: gpuType,
        hasGpu: gpus.length > 0,
        devices: gpus
      },
      network: {
        rxSpeed,
        txSpeed,
        totalRxBytes,
        totalTxBytes,
        interfaces
      },
      topProcesses
    };
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

export const metricsCollector = new MetricsCollector();
