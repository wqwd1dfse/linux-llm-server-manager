import {
  assertSshTargetContext,
  captureSshTargetContext,
  executeCommand,
  getConnectionStatus
} from './sshManager.js';
import { getConfig } from './config.js';
export const METRICS_SHELL = 'bash';

const GPU_VENDOR_BY_ID = Object.freeze({
  '0x1002': 'AMD',
  '0x10de': 'NVIDIA',
  '0x8086': 'Intel'
});

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized || /^(n\/a|not supported|unknown|-)$/i.test(normalized)) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePciSlot(value) {
  const slot = String(value || '').trim().toLowerCase();
  const match = slot.match(/([0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/);
  return match ? match[1] : slot;
}

function gpuVendor(vendorId, description = '', driver = '') {
  const normalizedId = String(vendorId || '').trim().toLowerCase();
  if (GPU_VENDOR_BY_ID[normalizedId]) return GPU_VENDOR_BY_ID[normalizedId];

  const haystack = String(description) + ' ' + String(driver);
  if (/nvidia/i.test(haystack)) return 'NVIDIA';
  if (/(amd|ati|amdgpu|radeon)/i.test(haystack)) return 'AMD';
  if (/(intel|i915|\bxe\b)/i.test(haystack)) return 'Intel';
  return 'Generic';
}

function cleanGpuDescription(description, fallback) {
  const cleaned = String(description || '')
    .replace(/^(VGA compatible controller|3D controller|Display controller|Processing accelerators?):\s*/i, '')
    .trim();
  return cleaned || fallback;
}

function normalizeGpuName(description, fallback, vendor, memoryTotalBytes) {
  const cleaned = cleanGpuDescription(description, fallback)
    .replace(/\s+\(rev\s+[0-9a-f]+\)$/i, '')
    .trim();

  // PCI ID databases use one ambiguous label for several Vega 20 products and
  // can even include "MI50 32GB" for a physically different 16 GB board.
  // Prefer the hardware-reported VRAM capacity and avoid claiming a SKU that
  // cannot be distinguished from PCI identity alone.
  if (vendor === 'AMD' && /Vega\s*20/i.test(cleaned)) {
    const vramGiB = memoryTotalBytes > 0 ? Math.round(memoryTotalBytes / 1024 / 1024 / 1024) : 0;
    return `AMD Vega 20${vramGiB > 0 ? ` (${vramGiB} GB VRAM)` : ''}`;
  }

  if (vendor === 'AMD') {
    return cleaned
      .replace(/^Advanced Micro Devices, Inc\.\s*(?:\[AMD\/ATI\])?\s*/i, 'AMD ')
      .replace(/^\[AMD\/ATI\]\s*/i, 'AMD ')
      .trim();
  }
  return cleaned;
}

export function parseBlockDevices(lines = []) {
  const blockLines = Array.isArray(lines) ? lines : [];
  const jsonStart = blockLines.findIndex((line) => line.trim().startsWith('{'));

  let rawDevices = [];
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(blockLines.slice(jsonStart).join('\n'));
      rawDevices = Array.isArray(parsed.blockdevices) ? parsed.blockdevices : [];
    } catch (_) {
      rawDevices = [];
    }
  }

  if (rawDevices.length === 0) {
    rawDevices = blockLines
      .filter((line) => line.startsWith('BLOCK_DEVICE:'))
      .map((line) => {
        const [name, devicePath, type, transport, size, model, serial, rotational, vendor] = line.slice('BLOCK_DEVICE:'.length).split('|');
        return { name, path: devicePath, type, tran: transport, size, model, serial, rota: rotational, vendor };
      });
  }

  return rawDevices
    .filter((device) => String(device.type || '').toLowerCase() === 'disk')
    .map((device) => {
      const rotationalValue = device.rota;
      const rotational = rotationalValue === null || rotationalValue === undefined || rotationalValue === ''
        ? null
        : rotationalValue === true || rotationalValue === 1 || String(rotationalValue) === '1';

      return {
        name: String(device.name || device.kname || '').trim(),
        path: String(device.path || ('/dev/' + (device.kname || device.name || ''))).trim(),
        type: 'disk',
        transport: String(device.tran || '').trim().toLowerCase() || 'unknown',
        size: Math.max(0, Number.parseInt(device.size, 10) || 0),
        model: String(device.model || '').trim(),
        vendor: String(device.vendor || '').trim(),
        serial: String(device.serial || '').trim(),
        rotational
      };
    })
    .filter((device) => device.name);
}

export function parseGpuDevices(lines = []) {
  const gpuLines = (Array.isArray(lines) ? lines : []).map((line) => line.trim()).filter(Boolean);
  const devices = [];
  const detectedSlots = new Set();

  for (const line of gpuLines) {
    if (!line.startsWith('NVIDIA_CSV:')) continue;
    const parts = line.slice('NVIDIA_CSV:'.length).split(',').map((part) => part.trim());
    if (parts.length < 11) continue;

    const pciSlot = normalizePciSlot(parts[1]);
    if (pciSlot) detectedSlots.add(pciSlot);
    const memoryTotalMb = nullableNumber(parts[7]) || 0;
    const memoryUsedMb = nullableNumber(parts[8]) || 0;
    const powerDraw = nullableNumber(parts[10]);

    devices.push({
      index: parts[0],
      pciSlot,
      name: parts[2] || 'NVIDIA GPU',
      driverVersion: parts[3] || 'NVIDIA driver',
      temperature: nullableNumber(parts[4]),
      utilizationGpu: nullableNumber(parts[5]),
      utilizationMemory: nullableNumber(parts[6]),
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb: nullableNumber(parts[9]) ?? Math.max(0, memoryTotalMb - memoryUsedMb),
      powerDraw: powerDraw !== null ? powerDraw + ' W' : 'N/A',
      isDedicated: true,
      vendor: 'NVIDIA'
    });
  }

  for (const line of gpuLines) {
    if (!line.startsWith('DRM_GPU:')) continue;
    const parts = line.slice('DRM_GPU:'.length).split('|');
    if (parts.length < 10) continue;

    const [cardName, rawSlot, vendorId, deviceId, driver, busy, vramUsed, vramTotal, rawTemp, rawPower, ...descriptionParts] = parts;
    const pciSlot = normalizePciSlot(rawSlot);
    if (pciSlot && detectedSlots.has(pciSlot)) continue;

    const description = descriptionParts.join('|').trim();
    const vendor = gpuVendor(vendorId, description, driver);
    const memoryTotalBytes = nullableNumber(vramTotal) || 0;
    const memoryUsedBytes = nullableNumber(vramUsed) || 0;
    const memoryTotalMb = Math.round(memoryTotalBytes / 1024 / 1024);
    const memoryUsedMb = Math.round(memoryUsedBytes / 1024 / 1024);
    const tempValue = nullableNumber(rawTemp);
    const powerValue = nullableNumber(rawPower);
    const isDedicated = vendor === 'NVIDIA' || vendor === 'AMD' || memoryTotalBytes > 0;
    const fallbackName = vendor + ' GPU (' + (vendorId || 'unknown') + ':' + (deviceId || 'unknown') + ')';

    devices.push({
      index: cardName.replace(/^card/, '') || devices.length,
      pciSlot,
      name: normalizeGpuName(description, fallbackName, vendor, memoryTotalBytes),
      driverVersion: driver ? driver + ' (Linux DRM)' : 'Linux DRM',
      temperature: tempValue !== null && tempValue > 1000 ? Math.round(tempValue / 100) / 10 : tempValue,
      utilizationGpu: nullableNumber(busy),
      utilizationMemory: memoryTotalBytes > 0 ? Math.round((memoryUsedBytes / memoryTotalBytes) * 100) : null,
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb: Math.max(0, memoryTotalMb - memoryUsedMb),
      powerDraw: powerValue !== null && powerValue > 0 ? (powerValue / 1000000).toFixed(1) + ' W' : 'N/A',
      isDedicated,
      note: isDedicated ? 'Discrete GPU / display adapter' : 'Integrated GPU / display adapter',
      vendor
    });
    if (pciSlot) detectedSlots.add(pciSlot);
  }

  for (const line of gpuLines) {
    if (!line.startsWith('PCI_SYSFS:')) continue;
    const [rawSlot, vendorId, deviceId, driver] = line.slice('PCI_SYSFS:'.length).split('|');
    const pciSlot = normalizePciSlot(rawSlot);
    if (pciSlot && detectedSlots.has(pciSlot)) continue;

    const vendor = gpuVendor(vendorId, '', driver);
    const isDedicated = vendor === 'NVIDIA' || vendor === 'AMD';
    devices.push({
      index: devices.length,
      pciSlot,
      name: vendor + ' GPU (' + (vendorId || 'unknown') + ':' + (deviceId || 'unknown') + ')',
      driverVersion: driver ? driver + ' (Linux PCI)' : 'Linux PCI device',
      temperature: null,
      utilizationGpu: null,
      utilizationMemory: null,
      memoryTotalMb: 0,
      memoryUsedMb: 0,
      memoryFreeMb: 0,
      powerDraw: 'N/A',
      isDedicated,
      note: isDedicated ? 'Discrete GPU / display adapter' : 'Integrated GPU / display adapter',
      vendor
    });
    if (pciSlot) detectedSlots.add(pciSlot);
  }
  for (const line of gpuLines) {
    if (!line.startsWith('PCI_DISPLAY:')) continue;
    const pci = line.slice('PCI_DISPLAY:'.length).trim();
    const slotMatch = pci.match(/^(\S+)\s+(.+)$/);
    if (!slotMatch) continue;

    const pciSlot = normalizePciSlot(slotMatch[1]);
    if (pciSlot && detectedSlots.has(pciSlot)) continue;

    const description = slotMatch[2];
    const vendor = gpuVendor('', description, '');
    const isDedicated = vendor === 'NVIDIA' || vendor === 'AMD';
    devices.push({
      index: devices.length,
      pciSlot,
      name: cleanGpuDescription(description, vendor + ' GPU'),
      driverVersion: 'Linux PCI device',
      temperature: null,
      utilizationGpu: null,
      utilizationMemory: null,
      memoryTotalMb: 0,
      memoryUsedMb: 0,
      memoryFreeMb: 0,
      powerDraw: 'N/A',
      isDedicated,
      note: isDedicated ? 'Discrete GPU / display adapter' : 'Integrated GPU / display adapter',
      vendor
    });
    if (pciSlot) detectedSlots.add(pciSlot);
  }

  const vendors = new Set(devices.map((device) => device.vendor.toLowerCase()));
  const type = devices.length === 0 ? 'none' : vendors.size === 1 ? [...vendors][0] : 'mixed';
  return { type, hasGpu: devices.length > 0, devices };
}

export class MetricsCollector {
  constructor({
    executeCommandFn = executeCommand,
    getConnectionStatusFn = getConnectionStatus,
    captureTargetContextFn = captureSshTargetContext,
    assertTargetContextFn = assertSshTargetContext
  } = {}) {
    this.executeCommand = executeCommandFn;
    this.getConnectionStatus = getConnectionStatusFn;
    this.captureTargetContext = captureTargetContextFn;
    this.assertTargetContext = assertTargetContextFn;
    this.latestSnapshot = null;
    this.history = [];
    this.historyRetentionMs = 60 * 60 * 1000;
    this.maxHistoryLength = 7200; // 60 minutes at the minimum supported 500 ms interval
    this.isCollecting = false;
    this.timer = null;
    this.running = false;
    this.listeners = new Set();
    this.lastNetStats = { time: 0, rx: 0, tx: 0 };
    this.lastDiskStats = { time: 0, readBytes: 0, writeBytes: 0 };
    this.lastCpuStats = { time: 0, idle: 0, total: 0 };
    this.currentHost = null;
    this.currentTargetGeneration = null;
    this.activeTargetContext = null;
  }

  start(initialDelayMs = 100) {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(initialDelayMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext(delayMs = null) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const interval = delayMs !== null ? delayMs : (getConfig().metricsInterval || 2000);
    this.timer = setTimeout(async () => {
      this.timer = null;
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
        if (this.running) this.scheduleNext();
      }
    }, interval);
    this.timer.unref?.();
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
    const durations = { '5m': 5 * 60 * 1000, '30m': 30 * 60 * 1000, '60m': 60 * 60 * 1000 };
    const normalizedRange = Object.hasOwn(durations, range) ? range : '5m';
    const durationMs = durations[normalizedRange];
    const targetVisualPoints = 120;

    const cutoff = now - durationMs;
    const points = this.history.filter(p => p.t >= cutoff);

    let visualPoints = points;
    if (points.length > targetVisualPoints) {
      const step = (points.length - 1) / (targetVisualPoints - 1);
      visualPoints = Array.from({ length: targetVisualPoints }, (_, index) => (
        points[Math.round(index * step)]
      ));
    }

    const calcStats = (arr, key) => {
      const valid = arr.map(p => p[key]).filter(Number.isFinite);
      if (!valid.length) return { min: null, max: null, avg: null, current: null, status: 'unavailable' };
      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const avg = parseFloat((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1));
      const current = valid[valid.length - 1];
      return { min, max, avg, current, status: 'available' };
    };

    return {
      range: normalizedRange,
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

  updateLatestHistory(values = {}) {
    const latest = this.history.at(-1);
    if (!latest || Date.now() - latest.t > 10_000) return;
    for (const key of ['cpu', 'gpuJ', 'gpuE', 'gpuP', 'fanRpm', 'cpuPwm']) {
      const value = values[key];
      if (Number.isFinite(value)) latest[key] = value;
    }
  }

  resetRollingState(host = null, generation = null) {
    this.currentHost = host;
    this.currentTargetGeneration = generation;
    this.latestSnapshot = null;
    this.history = [];
    this.lastNetStats = { time: 0, rx: 0, tx: 0 };
    this.lastDiskStats = { time: 0, readBytes: 0, writeBytes: 0 };
    this.lastCpuStats = { time: 0, idle: 0, total: 0 };
  }

  notifyListeners(snapshot) {
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (_) {}
    }
  }

  clearDisconnectedSnapshot() {
    const hadSnapshot = this.latestSnapshot !== null;
    this.latestSnapshot = null;
    // An unexpected transport loss does not advance sshManager's generation.
    // Force a rolling-state reset if this host reconnects under a new session.
    this.currentTargetGeneration = null;
    if (hadSnapshot) this.notifyListeners(null);
  }

  targetContextsMatch(left, right) {
    return Boolean(left && right)
      && left.generation === right.generation
      && left.targetId === right.targetId;
  }

  isCollectionTargetCurrent(targetContext, host) {
    try {
      this.assertTargetContext(targetContext);
    } catch (error) {
      if (error?.code === 'SSH_TARGET_CHANGED') return false;
      throw error;
    }

    const status = this.getConnectionStatus();
    return status.connected === true && status.host === host;
  }

  invalidateStaleCollection() {
    const status = this.getConnectionStatus();
    if (!status.connected) {
      this.clearDisconnectedSnapshot();
      return;
    }

    const currentContext = this.captureTargetContext();
    const host = currentContext.targetId || status.host;
    const hadSnapshot = this.latestSnapshot !== null;
    if (this.currentHost !== host || this.currentTargetGeneration !== currentContext.generation) {
      this.resetRollingState(host, currentContext.generation);
    } else {
      this.latestSnapshot = null;
    }
    if (hadSnapshot) this.notifyListeners(null);
  }

  async collect() {
    const status = this.getConnectionStatus();
    if (!status.connected) {
      this.clearDisconnectedSnapshot();
      return null;
    }

    const targetContext = this.captureTargetContext();
    const targetHost = targetContext.targetId || status.host;
    if (targetHost !== status.host) {
      this.invalidateStaleCollection();
      return null;
    }

    if (this.isCollecting) {
      if (!this.targetContextsMatch(this.activeTargetContext, targetContext)) {
        if (this.currentHost !== targetHost || this.currentTargetGeneration !== targetContext.generation) {
          this.resetRollingState(targetHost, targetContext.generation);
        }
        return null;
      }
      return this.latestSnapshot;
    }

    if (this.currentHost !== targetHost || this.currentTargetGeneration !== targetContext.generation) {
      this.resetRollingState(targetHost, targetContext.generation);
    }
    this.isCollecting = true;
    this.activeTargetContext = targetContext;
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

        echo "---BLOCK_DEVICES---"
        if command -v lsblk >/dev/null 2>&1; then
          echo "LSBLK_JSON:"
          lsblk -J -b -d -o NAME,KNAME,PATH,TYPE,TRAN,SIZE,MODEL,SERIAL,ROTA,VENDOR 2>/dev/null || true
        fi

        echo "---NET---"
        cat /proc/net/dev

        echo "---GPU---"
        if command -v nvidia-smi >/dev/null 2>&1; then
          nvidia-smi --query-gpu=index,pci.bus_id,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw --format=csv,noheader,nounits 2>/dev/null | sed 's/^/NVIDIA_CSV:/' || true
        fi
        for card in /sys/class/drm/card[0-9]*; do
          [ -e "$card/device" ] || continue
          card_name="\${card##*/}"
          case "$card_name" in card*[!0-9]*) continue ;; esac
          device=$(readlink -f "$card/device" 2>/dev/null || true)
          [ -n "$device" ] || continue
          slot="\${device##*/}"
          vendor=$(cat "$card/device/vendor" 2>/dev/null || echo '')
          device_id=$(cat "$card/device/device" 2>/dev/null || echo '')
          driver_path=$(readlink -f "$card/device/driver" 2>/dev/null || true)
          driver="\${driver_path##*/}"
          kernel_release=$(uname -r 2>/dev/null || true)
          if [ -n "$driver" ] && [ -n "$kernel_release" ]; then
            driver="$driver $kernel_release"
          fi
          busy=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || echo '')
          vram_used=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || echo '')
          vram_total=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || echo '')
          temp=$(cat "$card/device"/hwmon/hwmon*/temp1_input 2>/dev/null | head -n 1 || true)
          power=$(cat "$card/device"/hwmon/hwmon*/power1_average 2>/dev/null | head -n 1 || true)
          if [ -z "$power" ]; then
            power=$(cat "$card/device"/hwmon/hwmon*/power1_input 2>/dev/null | head -n 1 || true)
          fi
          description=""
          if command -v lspci >/dev/null 2>&1; then
            description=$(lspci -s "$slot" 2>/dev/null | sed -E 's/^[^ ]+[[:space:]]+//' | tr '|\n' '  ' | xargs || true)
          fi
          echo "DRM_GPU:$card_name|$slot|$vendor|$device_id|$driver|$busy|$vram_used|$vram_total|$temp|$power|$description"
        done
        for pci in /sys/bus/pci/devices/*; do
          [ -e "$pci" ] || continue
          class=$(cat "$pci/class" 2>/dev/null || echo '')
          case "$class" in 0x0300*|0x0302*|0x0380*|0x1200*) ;; *) continue ;; esac
          slot="\${pci##*/}"
          vendor=$(cat "$pci/vendor" 2>/dev/null || echo '')
          device_id=$(cat "$pci/device" 2>/dev/null || echo '')
          driver_path=$(readlink -f "$pci/driver" 2>/dev/null || true)
          driver="\${driver_path##*/}"
          echo "PCI_SYSFS:$slot|$vendor|$device_id|$driver|$class"
        done
        if command -v lspci >/dev/null 2>&1; then
          lspci -D 2>/dev/null | grep -i -E 'vga|3d|display|processing accelerators' | sed 's/^/PCI_DISPLAY:/' || true
        fi

        echo "---TOP_CPU_MEM---"
        ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 10
      `;

      const result = await this.executeCommand(METRICS_SHELL, ['-c', script], {
        timeoutMs: 8000,
        expectedTargetContext: targetContext
      });
      this.assertTargetContext(targetContext);
      const completionStatus = this.getConnectionStatus();
      if (!completionStatus.connected || completionStatus.host !== targetHost) {
        const error = new Error('Target server changed while metrics collection was pending');
        error.code = 'SSH_TARGET_CHANGED';
        throw error;
      }
      if (!result.success && !result.stdout) {
        throw new Error(result.stderr || '指标采集命令执行失败');
      }

      const parsed = this.parseSystemOutput(result.stdout);
      this.latestSnapshot = parsed;

      // Record real timestamped sample to history
      const now = Date.now();
      const primaryGpu = parsed.gpu?.devices?.[0];
      const gpuPower = Number.parseFloat(primaryGpu?.powerDraw);
      this.history.push({
        t: now,
        // CPU usage is not a temperature. The fan status sampler enriches this
        // point with the actual package/junction/edge sensors when available.
        cpu: null,
        gpuJ: null,
        gpuE: primaryGpu?.temperature ?? null,
        gpuP: Number.isFinite(gpuPower) ? gpuPower : null,
        fanRpm: null, // Populated by fan status if queried
        cpuPwm: null
      });

      const cutoff = now - this.historyRetentionMs;
      const firstRetained = this.history.findIndex((point) => point.t >= cutoff);
      if (firstRetained > 0) this.history.splice(0, firstRetained);
      if (this.history.length > this.maxHistoryLength) {
        this.history.splice(0, this.history.length - this.maxHistoryLength);
      }

      // Notify listeners (WebSockets)
      this.notifyListeners(parsed);

      return parsed;
    } catch (error) {
      if (error?.code === 'SSH_TARGET_CHANGED' || !this.isCollectionTargetCurrent(targetContext, targetHost)) {
        this.invalidateStaleCollection();
        return null;
      }
      throw error;
    } finally {
      this.isCollecting = false;
      this.activeTargetContext = null;
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
    const blockDevices = parseBlockDevices(sections['BLOCK_DEVICES'] || []);
    const physicalDeviceNames = new Set(blockDevices.map((device) => device.name));

    // Disk I/O Speeds
    const diskstatLines = sections['DISKSTATS'] || [];
    let totalReadSectors = 0;
    let totalWriteSectors = 0;

    for (const line of diskstatLines) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 14) {
        const devName = p[2];
        if (physicalDeviceNames.has(devName) || (physicalDeviceNames.size === 0 && /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk[0-9]+|md[0-9]+)$/.test(devName))) {
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

    // Parse GPU inventory and telemetry from NVIDIA, DRM/sysfs, then PCI fallbacks.
    const gpu = parseGpuDevices(sections['GPU'] || []);
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
        partitions: disks,
        devices: blockDevices
      },
      gpu,
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
