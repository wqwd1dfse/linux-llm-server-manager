import { Router } from 'express';
import { executeCommand } from '../sshManager.js';
import { metricsCollector } from '../metricsCollector.js';
import { detectGpus } from '../gpuDetector.js';

const router = Router();

const FAN_SERVICE_NAMES = ['fan-control', 'mi50-fan-control'];

async function findInstalledFanService() {
  for (const serviceName of FAN_SERVICE_NAMES) {
    const result = await executeCommand(
      'systemctl',
      ['show', serviceName, '--property=LoadState', '--value'],
      { timeoutMs: 4000 }
    );
    if (result.success && result.stdout.trim() === 'loaded') return serviceName;
  }
  return null;
}

function sendMissingFanService(res) {
  return res.status(503).json({
    success: false,
    status: 'service_not_installed',
    error: '目标 Linux 主机未安装 fan-control.service。请从项目 linux/fan-control 目录下载并安装。'
  });
}

// Shell helper to query comprehensive fan speeds, PWMs, and real hardware temperatures
const FULL_FAN_SENSORS_SCRIPT = `
GPU_HWMON=""
NCT_HWMON=""
CORETEMP_HWMON=""
LM_HWMON=""
WIFI_HWMON=""

for h in /sys/class/hwmon/hwmon*; do
  [ -r "$h/name" ] || continue
  n="$(cat "$h/name" 2>/dev/null)"
  if [ "$n" = "amdgpu" ] || [ "$n" = "radeon" ]; then GPU_HWMON="$h"; fi
  if [ "$n" = "nct6776" ] || [ "$n" = "nct6775" ] || [ "$n" = "nct6779" ] || [ "$n" = "nct6791" ] || [ "$n" = "nct6792" ] || [ "$n" = "nct6793" ] || [ "$n" = "nct6795" ] || [ "$n" = "nct6796" ] || [ "$n" = "nct6797" ] || [ "$n" = "nct6798" ]; then NCT_HWMON="$h"; fi
  if [ "$n" = "coretemp" ]; then CORETEMP_HWMON="$h"; fi
  if [ "$n" = "lm96163" ]; then LM_HWMON="$h"; fi
  if [ "$n" = "iwlwifi_1" ]; then WIFI_HWMON="$h"; fi
done

if [ -z "$NCT_HWMON" ]; then
  for h in /sys/class/hwmon/hwmon*; do
    if [ "$h" != "$GPU_HWMON" ] && { [ -f "$h/pwm2" ] || [ -f "$h/pwm1" ]; }; then
      NCT_HWMON="$h"
      break
    fi
  done
fi

echo "---HWMON_PATHS---"
echo "GPU:$GPU_HWMON"
echo "NCT:$NCT_HWMON"
echo "CORETEMP:$CORETEMP_HWMON"

echo "---GPU_DATA---"
if [ -n "$GPU_HWMON" ]; then
  echo "GPU_EDGE:$(cat $GPU_HWMON/temp1_input 2>/dev/null || echo '')"
  echo "GPU_JUNCTION:$(cat $GPU_HWMON/temp2_input 2>/dev/null || echo '')"
  echo "GPU_MEM:$(cat $GPU_HWMON/temp3_input 2>/dev/null || echo '')"
  echo "GPU_PWM:$(cat $GPU_HWMON/pwm1 2>/dev/null || echo '')"
  echo "GPU_RPM:$(cat $GPU_HWMON/fan1_input 2>/dev/null || echo '')"
  gpu_power=$(cat "$GPU_HWMON"/power1_average 2>/dev/null || true)
  if [ -z "$gpu_power" ]; then
    gpu_power=$(cat "$GPU_HWMON"/power1_input 2>/dev/null || true)
  fi
  echo "GPU_POWER:$gpu_power"
fi

echo "---NCT_FANS---"
if [ -n "$NCT_HWMON" ]; then
  echo "CPU_FAN_PWM:$(cat $NCT_HWMON/pwm1 2>/dev/null || echo '')"
  echo "CPU_FAN_RPM:$(cat $NCT_HWMON/fan1_input 2>/dev/null || echo '')"
  echo "FAN_PWM:$(cat $NCT_HWMON/pwm2 2>/dev/null || echo '')"
  echo "FAN_RPM:$(cat $NCT_HWMON/fan2_input 2>/dev/null || echo '')"
  echo "AUX_FAN_PWM:$(cat $NCT_HWMON/pwm3 2>/dev/null || echo '')"
  echo "AUX_FAN_RPM:$(cat $NCT_HWMON/fan3_input 2>/dev/null || echo '')"
  echo "SYS_TEMP:$(cat $NCT_HWMON/temp1_input 2>/dev/null || echo '')"
  echo "AUXTIN:$(cat $NCT_HWMON/temp3_input 2>/dev/null || echo '')"
  echo "PECI:$(cat $NCT_HWMON/temp7_input 2>/dev/null || echo '')"
fi

echo "---CORETEMP---"
if [ -n "$CORETEMP_HWMON" ]; then
  for f in "$CORETEMP_HWMON"/temp*_input; do
    if [ -f "$f" ]; then
      lbl=$(cat "\${f%_input}_label" 2>/dev/null || basename "$f")
      val=$(cat "$f" 2>/dev/null || echo '')
      echo "$lbl:$val"
    fi
  done
fi

echo "---LM_WIFI---"
if [ -n "$LM_HWMON" ]; then
  echo "LM_DIODE:$(cat $LM_HWMON/temp2_input 2>/dev/null || echo '')"
fi
if [ -n "$WIFI_HWMON" ]; then
  echo "WIFI_TEMP:$(cat $WIFI_HWMON/temp1_input 2>/dev/null || echo '')"
fi

echo "---DISKS---"
for d in /dev/sd[a-z]; do
  if [ -b "$d" ]; then
    m=$(lsblk -d -n -o MODEL "$d" 2>/dev/null | xargs)
    t=$(smartctl -A "$d" 2>/dev/null | grep -i "Temperature_Celsius" | awk '{print $10}' | head -n 1)
    if [ -z "$t" ]; then
      t=$(smartctl -A "$d" 2>/dev/null | grep -i "Airflow_Temperature" | awk '{print $10}' | head -n 1)
    fi
    echo "$(basename "$d") ($m):\${t:-}"
  fi
done

echo "---SERVICE---"
if systemctl cat fan-control.service >/dev/null 2>&1; then
  echo "INSTALLED:1"
  echo "STATE:$(systemctl is-active fan-control.service 2>/dev/null || echo inactive)"
elif systemctl cat mi50-fan-control.service >/dev/null 2>&1; then
  echo "INSTALLED:1"
  echo "STATE:$(systemctl is-active mi50-fan-control.service 2>/dev/null || echo inactive)"
else
  echo "INSTALLED:0"
  echo "STATE:not-installed"
fi
`;

function parseMilliTemp(rawVal) {
  if (rawVal === undefined || rawVal === null || rawVal === '') return null;
  const num = parseInt(rawVal, 10);
  if (isNaN(num)) return null;
  return Math.round(num / 1000);
}

function parseIntOrNull(rawVal) {
  if (rawVal === undefined || rawVal === null || rawVal === '') return null;
  const num = parseInt(rawVal, 10);
  return isNaN(num) ? null : num;
}

// 1. Get Full Fan & Hardware Temperature Matrix
router.get('/status', async (req, res) => {
  try {
    const result = await executeCommand('sh', ['-c', FULL_FAN_SENSORS_SCRIPT], { timeoutMs: 7000 });
    const stdout = result.stdout || '';

    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const sections = {};
    let currentSec = 'INIT';

    for (const line of lines) {
      if (line.startsWith('---') && line.endsWith('---')) {
        currentSec = line.slice(3, -3);
        sections[currentSec] = [];
        continue;
      }
      if (!sections[currentSec]) sections[currentSec] = [];
      sections[currentSec].push(line);
    }

    const parsePairs = (arr) => {
      const map = {};
      if (!arr) return map;
      for (const item of arr) {
        const idx = item.indexOf(':');
        if (idx !== -1) {
          map[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
        }
      }
      return map;
    };

    const gpuMap = parsePairs(sections['GPU_DATA']);
    const nctMap = parsePairs(sections['NCT_FANS']);
    const coreMap = parsePairs(sections['CORETEMP']);
    const miscMap = parsePairs(sections['LM_WIFI']);
    const diskMap = parsePairs(sections['DISKS']);

    const gpuEdge = parseMilliTemp(gpuMap['GPU_EDGE']);
    const gpuJunction = parseMilliTemp(gpuMap['GPU_JUNCTION']);
    const gpuMem = parseMilliTemp(gpuMap['GPU_MEM']);
    const gpuRawPwm = parseIntOrNull(gpuMap['GPU_PWM']);
    const gpuPwmPercent = gpuRawPwm !== null ? Math.round((gpuRawPwm / 255) * 100) : null;
    const gpuRpm = parseIntOrNull(gpuMap['GPU_RPM']);
    const gpuPowerW = gpuMap['GPU_POWER'] ? Math.round((parseInt(gpuMap['GPU_POWER'], 10) / 1000000) * 10) / 10 : null;

    const fanRawPwm = parseIntOrNull(nctMap['FAN_PWM']);
    const fanPwmPercent = fanRawPwm !== null ? Math.round((fanRawPwm / 255) * 100) : null;
    const fanRpm = parseIntOrNull(nctMap['FAN_RPM']);

    const cpuFanRawPwm = parseIntOrNull(nctMap['CPU_FAN_PWM']);
    const cpuFanPwmPercent = cpuFanRawPwm !== null ? Math.round((cpuFanRawPwm / 255) * 100) : null;
    const cpuFanRpm = parseIntOrNull(nctMap['CPU_FAN_RPM']);

    const auxFanRawPwm = parseIntOrNull(nctMap['AUX_FAN_PWM']);
    const auxFanPwmPercent = auxFanRawPwm !== null ? Math.round((auxFanRawPwm / 255) * 100) : null;
    const auxFanRpm = parseIntOrNull(nctMap['AUX_FAN_RPM']);

    const coresList = [];
    let packageTemp = null;
    for (const [k, v] of Object.entries(coreMap)) {
      const t = parseMilliTemp(v);
      if (t !== null) {
        if (k.toLowerCase().includes('package')) {
          packageTemp = t;
        } else {
          coresList.push({ name: k, temp: t });
        }
      }
    }

    const cpuDiode = parseMilliTemp(miscMap['LM_DIODE']);
    const cpuPeci = parseMilliTemp(nctMap['PECI']);
    const sysTemp = parseMilliTemp(nctMap['SYS_TEMP']);
    const auxTemp = nctMap['AUXTIN'] ? (parseInt(nctMap['AUXTIN'], 10) / 1000).toFixed(1) : null;
    const wifiTemp = parseMilliTemp(miscMap['WIFI_TEMP']);

    const disksList = [];
    for (const [diskName, tempVal] of Object.entries(diskMap)) {
      const t = parseInt(tempVal, 10);
      disksList.push({ name: diskName, temp: !isNaN(t) && t > 0 ? t : null });
    }

    const serviceMap = parsePairs(sections['SERVICE']);
    const serviceInstalled = serviceMap['INSTALLED'] === '1';
    const serviceActive = serviceMap['STATE'] === 'active';

    const gpuInfo = await detectGpus();
    const primaryGpu = gpuInfo.primary || {};

    const statusData = {
      service: {
        name: 'fan-control',
        installed: serviceInstalled,
        isActive: serviceActive,
        statusText: !serviceInstalled ? '未安装 (Not Installed)' : serviceActive ? '自动温控中 (Active)' : '已暂停 (Manual Override)'
      },
      gpuInfo: {
        count: gpuInfo.count,
        hasMultiGpu: gpuInfo.hasMultiGpu,
        primaryName: primaryGpu.name || 'GPU 加速卡',
        vendor: primaryGpu.vendor || 'AMD',
        cards: gpuInfo.gpus
      },
      fans: {
        fan: {
          name: 'Fan 外置风扇',
          rpm: fanRpm,
          pwmPercent: fanPwmPercent,
          rawPwm: fanRawPwm,
          maxRpm: 4950,
          status: fanRpm !== null ? 'available' : 'unavailable'
        },
        cpu: {
          name: 'CPU 处理器散热风扇',
          rpm: cpuFanRpm,
          pwmPercent: cpuFanPwmPercent,
          rawPwm: cpuFanRawPwm,
          maxRpm: 3000,
          status: cpuFanRpm !== null || cpuFanPwmPercent !== null ? 'available' : 'unavailable'
        },
        gpu: {
          name: `${primaryGpu.name || 'GPU'} 板载风扇`,
          rpm: gpuRpm,
          // Prefer this request's direct hwmon sample. GPU discovery is cached for
          // hardware metadata and can otherwise leave the fan readout several seconds behind.
          pwmPercent: gpuPwmPercent !== null ? gpuPwmPercent : (primaryGpu.fanPwmPct ?? null),
          rawPwm: gpuRawPwm !== null ? gpuRawPwm : (primaryGpu.fanPwm ?? null),
          maxRpm: 4950,
          status: gpuRpm !== null || gpuPwmPercent !== null ? 'available' : 'unavailable'
        },
        aux: {
          name: '机箱辅助散热风扇 (Chassis Aux)',
          rpm: auxFanRpm,
          pwmPercent: auxFanPwmPercent,
          rawPwm: auxFanRawPwm,
          maxRpm: 2500,
          status: auxFanRpm !== null || auxFanPwmPercent !== null ? 'available' : 'unavailable'
        }
      },
      temperatures: {
        cpu: {
          package: packageTemp !== null ? packageTemp : (cpuDiode !== null ? cpuDiode : null),
          diode: cpuDiode,
          peci: cpuPeci,
          cores: coresList
        },
        gpu: {
          name: primaryGpu.name || 'GPU 加速卡',
          vendor: primaryGpu.vendor || 'AMD',
          junction: primaryGpu.tempJunction ?? gpuJunction,
          mem: primaryGpu.tempMem ?? gpuMem,
          edge: primaryGpu.tempEdge ?? gpuEdge,
          powerW: primaryGpu.powerW ?? gpuPowerW,
          vramTotal: primaryGpu.vramTotal || null,
          vramUsed: primaryGpu.vramUsed || null
        },
        disks: disksList,
        system: {
          sysTemp,
          auxTemp: auxTemp ? parseFloat(auxTemp) : null,
          wifiTemp
        }
      }
    };

    const representativeFanRpm = [fanRpm, cpuFanRpm, gpuRpm, auxFanRpm]
      .find(Number.isFinite);
    metricsCollector.updateLatestHistory({
      cpu: statusData.temperatures.cpu.package,
      gpuJ: statusData.temperatures.gpu.junction,
      gpuE: statusData.temperatures.gpu.edge,
      gpuP: statusData.temperatures.gpu.powerW,
      fanRpm: representativeFanRpm,
      cpuPwm: cpuFanPwmPercent
    });

    res.json({
      success: true,
      data: statusData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Query Real Historical Curves
router.get('/history', (req, res) => {
  try {
    const { range = '5m' } = req.query;
    const historyData = metricsCollector.getHistory(range);
    res.json({
      success: true,
      data: historyData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Fail-Safe Closed-Loop Manual PWM Control
router.post('/manual', async (req, res) => {
  const { target: requestedTarget = 'all', percent = 80, fans } = req.body;
  // Backward-compatible input alias; all responses use the generic fan field.
  const target = requestedTarget === 'p12' ? 'fan' : requestedTarget;

  const validTargets = ['all', 'fan', 'cpu', 'gpu', 'aux'];
  if (!validTargets.includes(target)) {
    return res.status(400).json({ success: false, error: `无效的风扇控制目标: ${target}` });
  }

  const clampPercent = (val) => {
    const num = parseInt(val, 10);
    if (isNaN(num)) return 50;
    return Math.max(0, Math.min(100, num));
  };

  let fanPct = clampPercent(percent);
  let cpuPct = fanPct;
  let gpuPct = fanPct;
  let auxPct = fanPct;

  if (fans && typeof fans === 'object') {
    if (typeof fans.fan !== 'undefined') fanPct = clampPercent(fans.fan);
    else if (typeof fans.p12 !== 'undefined') fanPct = clampPercent(fans.p12);
    if (typeof fans.cpu !== 'undefined') cpuPct = clampPercent(fans.cpu);
    if (typeof fans.gpu !== 'undefined') gpuPct = clampPercent(fans.gpu);
    if (typeof fans.aux !== 'undefined') auxPct = clampPercent(fans.aux);
  }

  const fanRaw = Math.round((fanPct * 255) / 100);
  const cpuRaw = Math.round((cpuPct * 255) / 100);
  const gpuRaw = Math.round((gpuPct * 255) / 100);
  const auxRaw = Math.round((auxPct * 255) / 100);

  const controlScript = `
    NCT=""
    GPU=""
    for h in /sys/class/hwmon/hwmon*; do
      [ -r "$h/name" ] || continue
      n="$(cat "$h/name" 2>/dev/null)"
      case "$n" in
        amdgpu|radeon) GPU="$h" ;;
        nct*|it87*|w83627*|f718*) NCT="$h" ;;
      esac
    done

    if [ -z "$NCT" ]; then
      for h in /sys/class/hwmon/hwmon*; do
        if [ "$h" != "$GPU" ] && { [ -f "$h/pwm2" ] || [ -f "$h/pwm1" ]; }; then
          NCT="$h"
          break
        fi
      done
    fi

    if [ -z "$NCT" ] && [ -z "$GPU" ]; then
      echo "STATUS:NO_HWMON"
      exit 0
    fi

    systemctl stop fan-control 2>/dev/null || systemctl stop mi50-fan-control 2>/dev/null || true

    WRITE_COUNT=0
    READBACK_MISMATCH=0

    # 1. External fan (pwm2)
    if [ -n "$NCT" ] && [ -f "$NCT/pwm2" ] && { [ "${target}" = "fan" ] || [ "${target}" = "all" ] || [ -n "${fans ? '1' : ''}" ]; }; then
      [ -f "$NCT/pwm2_enable" ] && echo 1 > "$NCT/pwm2_enable" 2>/dev/null || true
      echo ${fanRaw} > "$NCT/pwm2" 2>/dev/null
      READ_FAN="$(cat "$NCT/pwm2" 2>/dev/null || echo -1)"
      WRITE_COUNT=$((WRITE_COUNT+1))
      DIFF=$((READ_FAN - ${fanRaw}))
      [ $DIFF -lt 0 ] && DIFF=$(( -DIFF ))
      [ $DIFF -gt 2 ] && READBACK_MISMATCH=$((READBACK_MISMATCH+1))
    fi

    # 2. CPU Fan (pwm1)
    if [ -n "$NCT" ] && [ -f "$NCT/pwm1" ] && { [ "${target}" = "cpu" ] || [ "${target}" = "all" ] || [ -n "${fans ? '1' : ''}" ]; }; then
      [ -f "$NCT/pwm1_enable" ] && echo 1 > "$NCT/pwm1_enable" 2>/dev/null || true
      echo ${cpuRaw} > "$NCT/pwm1" 2>/dev/null
      READ_CPU="$(cat "$NCT/pwm1" 2>/dev/null || echo -1)"
      WRITE_COUNT=$((WRITE_COUNT+1))
      DIFF=$((READ_CPU - ${cpuRaw}))
      [ $DIFF -lt 0 ] && DIFF=$(( -DIFF ))
      [ $DIFF -gt 2 ] && READBACK_MISMATCH=$((READBACK_MISMATCH+1))
    fi

    # 3. GPU Fan (pwm1)
    if [ -n "$GPU" ] && [ -f "$GPU/pwm1" ] && { [ "${target}" = "gpu" ] || [ "${target}" = "all" ] || [ -n "${fans ? '1' : ''}" ]; }; then
      [ -f "$GPU/pwm1_enable" ] && echo 1 > "$GPU/pwm1_enable" 2>/dev/null || true
      echo ${gpuRaw} > "$GPU/pwm1" 2>/dev/null
      READ_GPU="$(cat "$GPU/pwm1" 2>/dev/null || echo -1)"
      WRITE_COUNT=$((WRITE_COUNT+1))
      DIFF=$((READ_GPU - ${gpuRaw}))
      [ $DIFF -lt 0 ] && DIFF=$(( -DIFF ))
      [ $DIFF -gt 2 ] && READBACK_MISMATCH=$((READBACK_MISMATCH+1))
    fi

    if [ $WRITE_COUNT -eq 0 ]; then
      echo "STATUS:NO_MATCHING_NODES"
      exit 0
    fi

    if [ $READBACK_MISMATCH -gt 0 ]; then
      # Fail-Safe Auto Recovery
      systemctl restart fan-control 2>/dev/null || systemctl restart mi50-fan-control 2>/dev/null || true
      RECOVERED="$(systemctl is-active fan-control 2>/dev/null || systemctl is-active mi50-fan-control 2>/dev/null || echo inactive)"
      echo "STATUS:READBACK_MISMATCH:RECOVERED=$RECOVERED"
      exit 0
    fi

    echo "STATUS:SUCCESS:WRITTEN=$WRITE_COUNT"
  `;

  try {
    const result = await executeCommand('sh', ['-c', controlScript], { timeoutMs: 8000 });
    const stdout = (result.stdout || '').trim();

    if (stdout.includes('STATUS:NO_HWMON') || stdout.includes('STATUS:NO_MATCHING_NODES')) {
      return res.status(404).json({
        success: false,
        status: 'hardware_unavailable',
        error: '未检测到可控的风扇 PWM 硬件传感器节点。'
      });
    }

    if (stdout.includes('STATUS:READBACK_MISMATCH')) {
      const isRecovered = stdout.includes('RECOVERED=active');
      return res.status(500).json({
        success: false,
        status: 'verification_failed',
        failsafeRecovered: isRecovered,
        critical: !isRecovered,
        error: isRecovered
          ? 'PWM 写入回读校验不一致，已触发 Fail-Safe 自动恢复温控保护服务。'
          : 'CRITICAL: PWM 写入失败且自动温控保护恢复异常，请检查服务器散热守护服务！'
      });
    }

    res.json({
      success: true,
      message: target === 'all' || fans ? '全机各路风扇转速已安全设定并回读校验通过' : `${target.toUpperCase()} 风扇已设定为 ${percent}%`,
      output: stdout
    });
  } catch (err) {
    // Attempt recovery on unexpected execution fault
    let failsafeActive = false;
    try {
      const serviceName = await findInstalledFanService();
      if (serviceName) {
        const recRes = await executeCommand('systemctl', ['restart', serviceName], { timeoutMs: 5000 });
        failsafeActive = recRes.success;
      }
    } catch (_) {}

    res.status(500).json({
      success: false,
      failsafeRecovered: failsafeActive,
      critical: !failsafeActive,
      error: failsafeActive
        ? `执行风扇控制发生异常: ${err.message}，已自动恢复温控保护。`
        : `CRITICAL: 执行异常且温控保护恢复失败: ${err.message}`
    });
  }
});

// 4. Preset Profiles
const handlePresetMode = async (req, res) => {
  try {
    const mode = req.body.mode || req.body.preset;
    const allowedModes = ['auto', 'full', 'quiet', 'balanced'];
    if (!allowedModes.includes(mode)) {
      return res.status(400).json({ success: false, error: `未知预设模式: ${mode}` });
    }

    if (mode === 'auto') {
      const serviceName = await findInstalledFanService();
      if (!serviceName) return sendMissingFanService(res);
      const serviceResult = await executeCommand('systemctl', ['restart', serviceName], { timeoutMs: 5000 });
      if (!serviceResult.success) throw new Error(serviceResult.stderr || 'fan-control.service 启动失败');

      const autoHwScript = `
        for h in /sys/class/hwmon/hwmon*; do
          [ -r "$h/name" ] || continue
          n="$(cat "$h/name" 2>/dev/null)"
          case "$n" in
            amdgpu|radeon)
              [ -f "$h/pwm1_enable" ] && echo 2 > "$h/pwm1_enable" 2>/dev/null || true
              ;;
            nct*|it87*|w83627*|f718*)
              [ -f "$h/pwm1_enable" ] && echo 5 > "$h/pwm1_enable" 2>/dev/null || true
              [ -f "$h/pwm2_enable" ] && echo 5 > "$h/pwm2_enable" 2>/dev/null || true
              [ -f "$h/pwm3_enable" ] && echo 5 > "$h/pwm3_enable" 2>/dev/null || true
              ;;
          esac
        done
      `;
      await executeCommand('sh', ['-c', autoHwScript], { timeoutMs: 5000 });

      return res.json({
        success: true,
        mode: 'auto',
        message: '已切换至「智能自动温控模式」'
      });
    }

    const pwmVal = mode === 'full' ? 255 : mode === 'quiet' ? 105 : 178;

    const script = `
      systemctl stop fan-control 2>/dev/null || systemctl stop mi50-fan-control 2>/dev/null || true

      for h in /sys/class/hwmon/hwmon*; do
        [ -r "$h/name" ] || continue
        n="$(cat "$h/name" 2>/dev/null)"
        case "$n" in
          amdgpu|radeon)
            [ -f "$h/pwm1_enable" ] && echo 1 > "$h/pwm1_enable" 2>/dev/null || true
            [ -f "$h/pwm1" ] && echo ${pwmVal} > "$h/pwm1" 2>/dev/null || true
            ;;
          nct*|it87*|w83627*|f718*)
            [ -f "$h/pwm1_enable" ] && echo 1 > "$h/pwm1_enable" 2>/dev/null || true
            [ -f "$h/pwm1" ] && echo ${pwmVal} > "$h/pwm1" 2>/dev/null || true
            [ -f "$h/pwm2_enable" ] && echo 1 > "$h/pwm2_enable" 2>/dev/null || true
            [ -f "$h/pwm2" ] && echo ${pwmVal} > "$h/pwm2" 2>/dev/null || true
            [ -f "$h/pwm3_enable" ] && echo 1 > "$h/pwm3_enable" 2>/dev/null || true
            [ -f "$h/pwm3" ] && echo ${pwmVal} > "$h/pwm3" 2>/dev/null || true
            ;;
          *)
            if [ -f "$h/pwm1" ] || [ -f "$h/pwm2" ]; then
              [ -f "$h/pwm1_enable" ] && echo 1 > "$h/pwm1_enable" 2>/dev/null || true
              [ -f "$h/pwm1" ] && echo ${pwmVal} > "$h/pwm1" 2>/dev/null || true
              [ -f "$h/pwm2_enable" ] && echo 1 > "$h/pwm2_enable" 2>/dev/null || true
              [ -f "$h/pwm2" ] && echo ${pwmVal} > "$h/pwm2" 2>/dev/null || true
            fi
            ;;
        esac
      done
      echo "PRESET_APPLIED:${mode}"
    `;

    const result = await executeCommand('sh', ['-c', script], { timeoutMs: 7000 });

    const messages = {
      full: '已开启「全机 100% 极速强冷模式 (4,500+ RPM)」',
      quiet: '已切换至「全机静音待机模式 (40% 低噪巡航)」',
      balanced: '已切换至「全机均衡散热模式 (70% 均衡巡航)」'
    };

    res.json({
      success: true,
      mode,
      message: messages[mode] || `模式已切换为 ${mode}`,
      output: result.stdout
    });
  } catch (err) {
    try {
      const serviceName = await findInstalledFanService();
      if (serviceName) await executeCommand('systemctl', ['start', serviceName], { timeoutMs: 5000 });
    } catch (_) {}
    res.status(500).json({ success: false, error: err.message });
  }
};

router.post('/preset', handlePresetMode);
router.post('/mode', handlePresetMode);

// 5. Control Fan Service Daemon
router.post('/service', async (req, res) => {
  try {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ success: false, error: '非法操作，仅支持 start/stop/restart' });
    }

    const serviceName = await findInstalledFanService();
    if (!serviceName) return sendMissingFanService(res);

    const result = await executeCommand('systemctl', [action, serviceName], { timeoutMs: 8000 });
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.stderr || 'Fan 温控服务操作失败' });
    }
    res.json({ success: true, message: 'Fan 温控服务已执行 ' + action, output: result.stdout || result.stderr });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Get Service Logs
router.get('/logs', async (req, res) => {
  try {
    const serviceName = await findInstalledFanService();
    if (!serviceName) return sendMissingFanService(res);

    const result = await executeCommand('journalctl', ['-u', serviceName, '-n', '60', '--no-pager'], { timeoutMs: 5000 });
    res.json({ success: true, logs: result.stdout || '暂无日志记录' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
