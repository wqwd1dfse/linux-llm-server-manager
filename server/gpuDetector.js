import { executeCommand } from './sshManager.js';

let cachedGpuInfo = null;
let lastGpuScanTime = 0;

/**
 * Dynamically detect all GPUs on the target server (AMD, NVIDIA, Intel, etc.)
 */
export async function detectGpus(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedGpuInfo && now - lastGpuScanTime < 4000) {
    return cachedGpuInfo;
  }

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
            is_known_32gb_gpu = 'MI50' in desc or 'Vega 20' in desc or 'Pro VII' in desc
            if is_known_32gb_gpu:
                card_name = 'AMD GPU 32GB'
                vendor = 'AMD'

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

            vram_total = '32.0 GB' if is_known_32gb_gpu else '未知'
            vram_total_bytes = 32 * 1024 * 1024 * 1024 if is_known_32gb_gpu else 0
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
                'driver': driver_name,
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

  try {
    const result = await executeCommand('python3', ['-c', script], { timeoutMs: 6000 });
    if (result.stdout) {
      const gpus = JSON.parse(result.stdout.trim());
      cachedGpuInfo = {
        count: gpus.length,
        primary: gpus[0] || null,
        gpus,
        hasMultiGpu: gpus.length > 1
      };
      lastGpuScanTime = now;
      return cachedGpuInfo;
    }
  } catch (err) {
    console.error('[GPU Detector] Error probing GPUs:', err.message);
  }

  // Return truthful empty response if detection failed
  return {
    count: 0,
    primary: null,
    gpus: [],
    hasMultiGpu: false,
    status: 'unavailable'
  };
}
