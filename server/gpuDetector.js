import {
  assertSshTargetContext,
  captureSshTargetContext,
  executeCommand,
  getConnectionStatus
} from './sshManager.js';
import { getConfig } from './config.js';

const gpuCacheByTarget = new Map();
const gpuScanByTarget = new Map();
const GPU_CACHE_TTL_MS = 4_000;
export const GPU_CACHE_MAX_TARGETS = 16;

function pruneGpuDetectionCache(now = Date.now()) {
  for (const [key, entry] of gpuCacheByTarget) {
    if (!entry || now - entry.cachedAt >= GPU_CACHE_TTL_MS) gpuCacheByTarget.delete(key);
  }
  while (gpuCacheByTarget.size > GPU_CACHE_MAX_TARGETS) {
    gpuCacheByTarget.delete(gpuCacheByTarget.keys().next().value);
  }
}

function cacheGpuDetection(targetKey, data, now = Date.now()) {
  // Refresh insertion order so the fixed-size map behaves as a small LRU.
  gpuCacheByTarget.delete(targetKey);
  gpuCacheByTarget.set(targetKey, { data, cachedAt: now });
  pruneGpuDetectionCache(now);
}

export function resolveGpuTargetIdentity(status = getConnectionStatus(), config = getConfig()) {
  const username = String(config.username || 'root');
  const host = String(config.host || '127.0.0.1');
  const port = Number(config.port || 22);
  const label = `${username}@${host}:${port}`;
  if (status?.connected && status.host && status.host !== label) {
    const error = new Error('SSH target is changing; GPU data is temporarily unavailable');
    error.code = 'SSH_TARGET_CHANGING';
    throw error;
  }
  return { key: JSON.stringify([username, host, port]), label };
}

export function resetGpuDetectionCache(targetKey = null) {
  if (targetKey === null) {
    gpuCacheByTarget.clear();
    gpuScanByTarget.clear();
    return;
  }
  gpuCacheByTarget.delete(targetKey);
  gpuScanByTarget.delete(targetKey);
}

/**
 * Dynamically detect all GPUs on the target server (AMD, NVIDIA, Intel, etc.)
 */
export async function detectGpus(forceRefresh = false, dependencies = {}) {
  const runCommand = dependencies.executeCommand || executeCommand;
  const readStatus = dependencies.getConnectionStatus || getConnectionStatus;
  const readConfig = dependencies.getConfig || getConfig;
  const captureTargetContext = dependencies.captureSshTargetContext || captureSshTargetContext;
  const assertTargetContext = dependencies.assertSshTargetContext || assertSshTargetContext;
  const targetContext = captureTargetContext();
  const target = resolveGpuTargetIdentity(readStatus(), readConfig());
  const now = Date.now();
  pruneGpuDetectionCache(now);
  const cached = gpuCacheByTarget.get(target.key);
  if (!forceRefresh && cached && now - cached.cachedAt < GPU_CACHE_TTL_MS) {
    gpuCacheByTarget.delete(target.key);
    gpuCacheByTarget.set(target.key, cached);
    return cached.data;
  }

  const inFlight = gpuScanByTarget.get(target.key);
  if (inFlight) return inFlight;

  const script = `
import os, glob, json, subprocess, re

gpus = []

# 1. Probe PCI Devices for Display & Accelerators
pci_map = {}
try:
    lspci_out = subprocess.check_output(['lspci', '-nn'], stderr=subprocess.DEVNULL).decode('utf-8')
    for line in lspci_out.splitlines():
        if re.search(r'VGA compatible controller|3D controller|Display controller|Processing accelerators', line, re.I):
            slot = line.split()[0]
            desc = line.split(': ', 1)[1] if ': ' in line else line
            pci_map[slot] = desc
except Exception:
    pass

# 2. Check NVIDIA SMI if available
try:
    smi_out = subprocess.check_output(['nvidia-smi', '--query-gpu=index,name,memory.total,memory.used,memory.free,temperature.gpu,power.draw,utilization.gpu', '--format=csv,noheader,nounits'], stderr=subprocess.DEVNULL).decode('utf-8')
    for line in smi_out.strip().splitlines():
        parts = [p.strip() for p in line.split(',')]
        if len(parts) >= 8:
            idx = int(parts[0])
            gpus.append({
                'id': idx,
                'vendor': 'NVIDIA',
                'name': parts[1],
                'vramTotalBytes': int(float(parts[2]) * 1024 * 1024),
                'vramUsedBytes': int(float(parts[3]) * 1024 * 1024),
                'vramTotal': f'{float(parts[2])/1024:.1f} GB',
                'vramUsed': f'{float(parts[3])/1024:.1f} GB',
                'tempEdge': float(parts[5]),
                'tempJunction': float(parts[5]),
                'tempMem': float(parts[5]),
                'powerW': float(parts[6]),
                'utilPercent': int(float(parts[7])),
                'driver': 'nvidia'
            })
except Exception:
    pass

# 3. Check AMD / Sysfs hwmon DRM cards
if not gpus:
    for hw in glob.glob('/sys/class/hwmon/hwmon*'):
        try:
            with open(os.path.join(hw, 'name')) as f:
                driver_name = f.read().strip()
        except Exception:
            continue

        if driver_name in ['amdgpu', 'nouveau', 'i915', 'xe']:
            card_id = len(gpus)
            card_name = 'GPU 加速卡'
            vendor = 'AMD' if driver_name == 'amdgpu' else 'Intel' if driver_name in ['i915', 'xe'] else 'Generic'

            pci_slot = ''
            desc = ''
            device_link = os.path.realpath(os.path.join(hw, 'device'))
            for slot, d in pci_map.items():
                if slot in device_link:
                    pci_slot = slot
                    desc = d
                    matches = re.findall(r'\\[(.*?)\\]', desc)
                    if len(matches) >= 2 and matches[-1] != 'AMD/ATI':
                        card_name = f'{vendor} {matches[-1]}'
                    elif matches:
                        card_name = f'{vendor} {matches[0]}'
                    else:
                        card_name = desc.split('controller: ')[-1]
                    break

            card_name = card_name.replace('Advanced Micro Devices, Inc.', '').strip()

            temp_edge = None
            temp_junction = None
            temp_mem = None

            for tf in glob.glob(os.path.join(hw, 'temp*_input')):
                try:
                    with open(tf) as f:
                        val = round(int(f.read().strip()) / 1000, 1)
                    label_path = tf.replace('_input', '_label')
                    label = os.path.basename(tf)
                    if os.path.exists(label_path):
                        with open(label_path) as lf: label = lf.read().strip().lower()

                    if 'junction' in label or 'temp2' in tf:
                        temp_junction = val
                    elif 'mem' in label or 'temp3' in tf:
                        temp_mem = val
                    elif 'edge' in label or 'temp1' in tf:
                        temp_edge = val
                except Exception:
                    pass

            power_w = None
            for pf in glob.glob(os.path.join(hw, 'power*_average')) + glob.glob(os.path.join(hw, 'power*_input')):
                try:
                    with open(pf) as f:
                        pw_val = round(int(f.read().strip()) / 1000000, 1)
                        if pw_val > 0:
                            power_w = pw_val
                            break
                except Exception:
                    pass

            vram_total = '未知'
            vram_total_bytes = 0
            vram_used = '--'

            vram_used_file = os.path.join(device_link, 'mem_info_vram_used')
            vram_total_file = os.path.join(device_link, 'mem_info_vram_total')
            if os.path.exists(vram_total_file):
                try:
                    with open(vram_total_file) as f:
                        vram_total_bytes = int(f.read().strip())
                        vram_total = f'{vram_total_bytes / (1024**3):.1f} GB'
                except Exception: pass
            if os.path.exists(vram_used_file):
                try:
                    with open(vram_used_file) as f:
                        used_bytes = int(f.read().strip())
                        vram_used = f'{used_bytes / (1024**3):.1f} GB'
                except Exception: pass

            # Vega 20's shared PCI ID description can list both Radeon Pro VII
            # and MI50 32GB even when the board reports 16GB. Do not guess the
            # commercial SKU; identify the silicon plus measured VRAM instead.
            if vendor == 'AMD' and re.search(r'Vega\\s*20', desc, re.I):
                size_gib = round(vram_total_bytes / (1024**3)) if vram_total_bytes > 0 else 0
                card_name = f'AMD Vega 20 ({size_gib} GB VRAM)' if size_gib else 'AMD Vega 20'

            driver_label = f'{driver_name} {os.uname().release}'

            fan_pwm = 0
            fan_pwm_pct = 0
            for pwmf in glob.glob(os.path.join(hw, 'pwm*')):
                if not pwmf.endswith('_enable') and not pwmf.endswith('_max') and not pwmf.endswith('_min'):
                    try:
                        with open(pwmf) as f:
                            fan_pwm = int(f.read().strip())
                            fan_pwm_pct = round((fan_pwm / 255) * 100)
                            break
                    except Exception: pass

            gpus.append({
                'id': card_id,
                'pciSlot': pci_slot,
                'vendor': vendor,
                'name': card_name,
                'driver': driver_label,
                'vramTotal': vram_total,
                'vramUsed': vram_used,
                'vramTotalBytes': vram_total_bytes,
                'tempEdge': temp_edge,
                'tempJunction': temp_junction,
                'tempMem': temp_mem,
                'powerW': power_w,
                'fanPwm': fan_pwm,
                'fanPwmPct': fan_pwm_pct,
                'utilPercent': 0
            })

# Fallback to lspci if no hwmon found
if not gpus and pci_map:
    for i, (slot, desc) in enumerate(pci_map.items()):
        vendor = 'AMD' if 'AMD' in desc or 'ATI' in desc else 'NVIDIA' if 'NVIDIA' in desc else 'Intel' if 'Intel' in desc else 'Generic'
        gpus.append({
            'id': i,
            'pciSlot': slot,
            'vendor': vendor,
            'name': desc.split('controller: ')[-1],
            'driver': 'generic',
            'vramTotal': '未知',
            'vramUsed': '--',
            'tempEdge': None,
            'tempJunction': None,
            'tempMem': None,
            'powerW': None,
            'fanPwm': 0,
            'fanPwmPct': 0,
            'utilPercent': 0
        })

print(json.dumps(gpus))
`;

  const scanPromise = (async () => {
    try {
      const result = await runCommand('python3', ['-c', script], {
        timeoutMs: 6000,
        expectedTargetContext: targetContext
      });
      assertTargetContext(targetContext);
      const currentTarget = resolveGpuTargetIdentity(readStatus(), readConfig());
      if (currentTarget.key !== target.key) {
        const error = new Error('SSH target changed while GPU detection was running');
        error.code = 'SSH_TARGET_CHANGED';
        throw error;
      }
      if (result.stdout) {
        const gpus = JSON.parse(result.stdout.trim());
        const data = {
          count: gpus.length,
          primary: gpus[0] || null,
          gpus,
          hasMultiGpu: gpus.length > 1,
          target: target.label
        };
        cacheGpuDetection(target.key, data);
        return data;
      }
    } catch (err) {
      console.error('[GPU Detector] Error probing GPUs:', err.message);
    }

    // Return truthful empty response if detection failed; never substitute a
    // cached result from a different SSH target.
    return {
      count: 0,
      primary: null,
      gpus: [],
      hasMultiGpu: false,
      status: 'unavailable',
      target: target.label
    };
  })();

  gpuScanByTarget.set(target.key, scanPromise);
  try {
    return await scanPromise;
  } finally {
    if (gpuScanByTarget.get(target.key) === scanPromise) gpuScanByTarget.delete(target.key);
  }
}
