// Fan & Multi-Component Thermal Control Console (Windows 11 Style)

const fanText = (zh, en) => window.localize ? window.localize(zh, en) : en;

let fanPollingInterval = null;
let currentFanHistoryRange = '5m';
let fanHistoryPoints = [];
let fanHoverIndex = -1;
let activePresetMode = 'auto';

window.initFan = function () {
  loadFanStatus(false);
  setupFanSliders();
  setupFanHistoryChart();

  if (fanPollingInterval) clearInterval(fanPollingInterval);
  fanPollingInterval = setInterval(() => {
    if (window.currentView === 'fan') {
      loadFanStatus(false);
      loadFanHistory(currentFanHistoryRange, false);
    }
  }, 2500);

  // Responsive resize
  window.addEventListener('resize', () => {
    if (window.currentView === 'fan') {
      drawFanHistoryCanvas();
    }
  });
};

// ----------------------------------------------------
// 1. Status & Metrics Pull (Truthful Sensor Reporting)
// ----------------------------------------------------
async function loadFanStatus(showToast = false) {
  try {
    const res = await window.api.request('/api/fan/status');
    const d = res.data;
    if (!d) return;

    // Service status badge
    const sBadge = document.getElementById('fan-service-badge');
    if (sBadge && d.service) {
      sBadge.innerText = d.service.isActive ? fanText('● 自动温控运行中', '● Automatic thermal control active') : fanText('○ 手动转速接管', '○ Manual fan control');
      sBadge.style.color = d.service.isActive ? 'var(--perf-green)' : 'var(--perf-yellow)';
      if (d.service.isActive) {
        activePresetMode = 'auto';
      }
      updatePresetButtonsUI(activePresetMode);
    }

    // Top Header Big Readout
    if (d.fans?.p12) {
      const p12RpmText = d.fans.p12.rpm !== null ? `${(d.fans.p12.rpm).toLocaleString()} RPM` : fanText('N/A (传感器离线)', 'N/A (sensor offline)');
      setText('fan-p12-rpm', p12RpmText);

      const cpuTempStr = d.temperatures?.cpu?.package !== null ? `${d.temperatures.cpu.package}°C` : 'N/A';
      const cpuPwmStr = d.fans.cpu?.pwmPercent !== null ? `${d.fans.cpu.pwmPercent}%` : 'N/A';
      setText('fan-cpu-status', fanText(`CPU 风扇: ${cpuPwmStr} PWM | 封装温度: ${cpuTempStr}`, `CPU fan: ${cpuPwmStr} PWM | package: ${cpuTempStr}`));

      // Fan Matrix Readouts
      setText('fan-p12-pwm', d.fans.p12.pwmPercent !== null ? `${d.fans.p12.pwmPercent}% (${d.fans.p12.rawPwm}/255)` : 'N/A');
      setProgressBar('fan-p12-progress', d.fans.p12.pwmPercent !== null ? d.fans.p12.pwmPercent : 0);

      setText('fan-cpu-pwm', d.fans.cpu.pwmPercent !== null ? `${d.fans.cpu.pwmPercent}% (${d.fans.cpu.rawPwm}/255)` : 'N/A');
      setText('fan-cpu-rpm', d.fans.cpu.rpm !== null && d.fans.cpu.rpm > 0 ? `${d.fans.cpu.rpm} RPM` : (d.fans.cpu.rpm === 0 ? '0 RPM' : fanText('PWM 智能调速', 'Smart PWM control')));
      setProgressBar('fan-cpu-progress', d.fans.cpu.pwmPercent !== null ? d.fans.cpu.pwmPercent : 0);

      setText('fan-gpu-pwm', d.fans.gpu.pwmPercent !== null ? `${d.fans.gpu.pwmPercent}% (${d.fans.gpu.rawPwm}/255)` : 'N/A');
      setText('fan-gpu-rpm', d.fans.gpu.rpm !== null && d.fans.gpu.rpm > 0 ? `${d.fans.gpu.rpm} RPM` : fanText('板载风机', 'Onboard fan'));
      setProgressBar('fan-gpu-progress', d.fans.gpu.pwmPercent !== null ? d.fans.gpu.pwmPercent : 0);

      setText('fan-aux-pwm', d.fans.aux.pwmPercent !== null ? `${d.fans.aux.pwmPercent}% (${d.fans.aux.rawPwm}/255)` : 'N/A');
      setProgressBar('fan-aux-progress', d.fans.aux.pwmPercent !== null ? d.fans.aux.pwmPercent : 0);
    }

    // CPU Temperatures
    if (d.temperatures?.cpu) {
      const tCpu = d.temperatures.cpu;
      setText('temp-cpu-package', tCpu.package !== null ? `${tCpu.package} °C` : 'N/A');
      setText('temp-cpu-diode', tCpu.diode !== null ? `${tCpu.diode} °C` : 'N/A');
      setText('temp-cpu-peci', tCpu.peci !== null ? `${tCpu.peci} °C` : 'N/A');
      if (tCpu.package !== null) setTempColor('temp-cpu-package', tCpu.package);

      const coreGrid = document.getElementById('cpu-cores-temp-grid');
      if (coreGrid && Array.isArray(tCpu.cores)) {
        if (tCpu.cores.length === 0) {
          coreGrid.innerHTML = '<span style="color: var(--win-text-muted); font-size: 11px;">无每核心独立测温数据</span>';
        } else {
          coreGrid.innerHTML = tCpu.cores.map(c => `
            <div class="sensor-chip">
              <span class="sensor-chip-name">${window.escapeHtml(c.name)}</span>
              <span class="sensor-chip-val" style="color: ${getTempColorCode(c.temp)}">${c.temp !== null ? `${c.temp} °C` : 'N/A'}</span>
            </div>
          `).join('');
        }
      }
    }

    // GPU Temperatures (Truthful)
    if (d.temperatures?.gpu) {
      const tGpu = d.temperatures.gpu;
      setText('temp-gpu-junction', tGpu.junction !== null ? `${tGpu.junction} °C` : 'N/A');
      setText('temp-gpu-mem', tGpu.mem !== null ? `${tGpu.mem} °C` : 'N/A');
      setText('temp-gpu-edge', tGpu.edge !== null ? `${tGpu.edge} °C` : 'N/A');
      setText('temp-gpu-power', tGpu.powerW ? `${tGpu.powerW} W` : 'N/A');
      if (tGpu.junction !== null) setTempColor('temp-gpu-junction', tGpu.junction);
      if (tGpu.mem !== null) setTempColor('temp-gpu-mem', tGpu.mem);
      if (tGpu.edge !== null) setTempColor('temp-gpu-edge', tGpu.edge);
    }

    // Disk Temperatures
    if (d.temperatures?.disks) {
      const diskBox = document.getElementById('disk-temps-container');
      if (diskBox) {
        if (d.temperatures.disks.length === 0) {
          diskBox.innerHTML = '<span style="color: var(--win-text-muted); font-size: 11px;">未检测到支持 SMART 测温的磁盘</span>';
        } else {
          diskBox.innerHTML = d.temperatures.disks.map(dk => `
            <div class="sensor-chip" style="min-width: 130px;">
              <span class="sensor-chip-name">💾 ${window.escapeHtml(dk.name)}</span>
              <span class="sensor-chip-val" style="color: ${getTempColorCode(dk.temp)}">${dk.temp !== null && dk.temp > 0 ? `${dk.temp} °C` : 'N/A'}</span>
            </div>
          `).join('');
        }
      }
    }

    // System & Motherboard Temperatures
    if (d.temperatures?.system) {
      const tSys = d.temperatures.system;
      setText('temp-sys-board', tSys.sysTemp !== null ? `${tSys.sysTemp} °C` : 'N/A');
      setText('temp-sys-aux', tSys.auxTemp !== null ? `${tSys.auxTemp} °C` : 'N/A');
      setText('temp-sys-wifi', tSys.wifiTemp !== null ? `${tSys.wifiTemp} °C` : 'N/A');
    }

  } catch (err) {
    if (showToast) console.error('Failed to load fan status:', err);
  }
}

// ----------------------------------------------------
// 2. Preset Modes & Manual Controls
// ----------------------------------------------------
function updatePresetButtonsUI(mode) {
  const fullBtn = document.getElementById('btn-fan-mode-full');
  const autoBtn = document.getElementById('btn-fan-mode-auto');
  const quietBtn = document.getElementById('btn-fan-mode-quiet');

  const setBtnActive = (btn, isActive, activeColor) => {
    if (!btn) return;
    if (isActive) {
      btn.style.borderColor = activeColor;
      btn.style.boxShadow = `0 0 12px ${activeColor}55`;
      btn.style.transform = 'scale(1.02)';
    } else {
      btn.style.borderColor = 'var(--win-border)';
      btn.style.boxShadow = 'none';
      btn.style.transform = 'none';
    }
  };

  setBtnActive(fullBtn, mode === 'full', 'var(--perf-red)');
  setBtnActive(autoBtn, mode === 'auto', 'var(--win-accent)');
  setBtnActive(quietBtn, mode === 'quiet', 'var(--perf-green)');
}

window.setPresetMode = async function (mode) {
  activePresetMode = mode;
  let tip = mode === 'full' ? '100% 全速暴力散热' : mode === 'quiet' ? '全机静音待机' : '智能自适应自动温控';
  window.toast(`正在切换至: ${tip}...`, 'info');
  updatePresetButtonsUI(mode);

  try {
    const res = await window.api.request('/api/fan/preset', {
      method: 'POST',
      body: JSON.stringify({ mode })
    });
    window.toast(res.message, 'success');
    loadFanStatus();
    loadFanHistory(currentFanHistoryRange, false);
  } catch (err) {
    window.toast(`设置失败: ${err.message}`, 'error');
  }
};

window.controlFanService = async function (action) {
  window.toast(`正在执行服务操作: ${action}...`, 'info');
  try {
    const res = await window.api.request('/api/fan/service', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    window.toast(res.message, 'success');
    loadFanStatus();
  } catch (err) {
    window.toast(`操作失败: ${err.message}`, 'error');
  }
};

window.applySingleFan = async function (target, sliderId) {
  activePresetMode = null;
  const slider = document.getElementById(sliderId);
  const pct = parseInt(slider?.value || '70', 10);
  window.toast(`正在设定 ${target.toUpperCase()} 风扇为 ${pct}%...`, 'info');
  updatePresetButtonsUI(null);

  try {
    const res = await window.api.request('/api/fan/manual', {
      method: 'POST',
      body: JSON.stringify({ target, percent: pct })
    });
    window.toast(res.message, 'success');
    loadFanStatus();
  } catch (err) {
    window.toast(`设定失败: ${err.message}`, 'error');
  }
};

window.applyAllFans = async function () {
  activePresetMode = null;
  window.toast('正在应用全机风扇设定...', 'info');
  updatePresetButtonsUI(null);

  const p12 = parseInt(document.getElementById('slider-fan-p12')?.value || '80', 10);
  const cpu = parseInt(document.getElementById('slider-fan-cpu')?.value || '70', 10);
  const gpu = parseInt(document.getElementById('slider-fan-gpu')?.value || '65', 10);
  const aux = parseInt(document.getElementById('slider-fan-aux')?.value || '65', 10);

  try {
    const res = await window.api.request('/api/fan/manual', {
      method: 'POST',
      body: JSON.stringify({
        fans: { p12, cpu, gpu, aux }
      })
    });
    window.toast(res.message || '已成功应用风扇设定', 'success');
    loadFanStatus();
  } catch (err) {
    window.toast(`设定失败: ${err.message}`, 'error');
  }
};

function setupFanSliders() {
  bindSlider('slider-fan-p12', 'val-fan-p12');
  bindSlider('slider-fan-cpu', 'val-fan-cpu');
  bindSlider('slider-fan-gpu', 'val-fan-gpu');
  bindSlider('slider-fan-aux', 'val-fan-aux');
}

function bindSlider(sliderId, labelId) {
  const slider = document.getElementById(sliderId);
  const label = document.getElementById(labelId);
  slider?.addEventListener('input', (e) => {
    if (label) label.innerText = `${e.target.value}%`;
  });
}

// ----------------------------------------------------
// 3. 📈 Historical 5 / 30 / 60 Min Temp & Power Chart
// ----------------------------------------------------
let fanSeriesVisible = { cpu: true, gpuJ: true, gpuE: true, gpuP: true };

window.toggleFanSeries = function (series) {
  if (typeof fanSeriesVisible[series] === 'undefined') return;
  fanSeriesVisible[series] = !fanSeriesVisible[series];

  const itemEl = document.getElementById(`legend-item-${series.toLowerCase()}`);
  if (itemEl) {
    itemEl.style.opacity = fanSeriesVisible[series] ? '1' : '0.35';
    itemEl.style.textDecoration = fanSeriesVisible[series] ? 'none' : 'line-through';
  }

  drawFanHistoryCanvas();
};

window.exportFanChartPNG = function () {
  const canvas = document.getElementById('fan-history-canvas');
  if (!canvas) return;

  try {
    const link = document.createElement('a');
    link.download = `Server_Thermal_Metrics_${currentFanHistoryRange}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.toast('已成功导出温度与功耗历史图表 PNG', 'success');
  } catch (err) {
    window.toast(`导出失败: ${err.message}`, 'error');
  }
};

function setupFanHistoryChart() {
  document.querySelectorAll('.fan-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fan-range-btn').forEach(b => b.classList.toggle('active', b === btn));
      currentFanHistoryRange = btn.getAttribute('data-range') || '5m';
      loadFanHistory(currentFanHistoryRange, true);
    });
  });

  const canvas = document.getElementById('fan-history-canvas');
  if (canvas) {
    canvas.addEventListener('mousemove', handleChartMouseMove);
    canvas.addEventListener('mouseleave', handleChartMouseLeave);
  }

  loadFanHistory(currentFanHistoryRange, false);
}

async function loadFanHistory(range = '5m', showToast = false) {
  try {
    const res = await window.api.request(`/api/fan/history?range=${range}`);
    const { points, stats } = res.data;
    fanHistoryPoints = points || [];

    if (fanHistoryPoints.length > 0) {
      const latest = fanHistoryPoints[fanHistoryPoints.length - 1];
      setText('chart-legend-cpu', latest.cpu !== null ? `${latest.cpu}°C` : '--');
      setText('chart-legend-gpuj', latest.gpuJ !== null ? `${latest.gpuJ}°C` : '--');
      setText('chart-legend-gpue', latest.gpuE !== null ? `${latest.gpuE}°C` : '--');
      setText('chart-legend-gpup', latest.gpuP !== null ? `${latest.gpuP}W` : '--');
      setText('chart-legend-p12', latest.p12Rpm !== null ? `${latest.p12Rpm.toLocaleString()} RPM` : '--');
    }

    if (stats) {
      if (stats.cpu) setText('stat-cpu-summary', stats.cpu.min !== null ? `最小: ${stats.cpu.min}°C | 均值: ${stats.cpu.avg}°C | 最大: ${stats.cpu.max}°C` : 'N/A');
      if (stats.gpuJunction) setText('stat-gpuj-summary', stats.gpuJunction.min !== null ? `最小: ${stats.gpuJunction.min}°C | 均值: ${stats.gpuJunction.avg}°C | 最大: ${stats.gpuJunction.max}°C` : 'N/A');
      if (stats.gpuPower) setText('stat-gpup-summary', stats.gpuPower.min !== null ? `最小: ${stats.gpuPower.min}W | 均值: ${stats.gpuPower.avg}W | 最大: ${stats.gpuPower.max}W` : 'N/A');
      if (stats.p12Rpm) setText('stat-p12-summary', stats.p12Rpm.current !== null ? `当前: ${(stats.p12Rpm.current).toLocaleString()} RPM | 均值: ${(stats.p12Rpm.avg).toLocaleString()} RPM` : 'N/A');
    }

    drawFanHistoryCanvas();
  } catch (err) {
    if (showToast) console.error('Failed to load history:', err);
  }
}

function drawSmoothCurve(ctx, pts, getX, getY, strokeColor, lineWidth, isAreaFill = false, fillGrad = null, plotBottom = 0, plotLeft = 0, plotWidth = 0) {
  const validPts = pts.map((p, i) => ({ x: getX(i), y: getY(p) })).filter(pt => pt.y !== null);
  if (validPts.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(validPts[0].x, validPts[0].y);
  for (let i = 0; i < validPts.length - 1; i++) {
    const xc = (validPts[i].x + validPts[i + 1].x) / 2;
    const yc = (validPts[i].y + validPts[i + 1].y) / 2;
    ctx.quadraticCurveTo(validPts[i].x, validPts[i].y, xc, yc);
  }
  ctx.lineTo(validPts[validPts.length - 1].x, validPts[validPts.length - 1].y);

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  if (isAreaFill && fillGrad) {
    ctx.lineTo(validPts[validPts.length - 1].x, plotBottom);
    ctx.lineTo(validPts[0].x, plotBottom);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();
  }
}

function drawFanHistoryCanvas() {
  const canvas = document.getElementById('fan-history-canvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect || rect.width < 100 || rect.height < 50) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const padLeft = 42;
  const padRight = 42;
  const padTop = 18;
  const padBottom = 26;

  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  // 1. Draw Grid & Axes
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.font = '10px Consolas, monospace';
  ctx.fillStyle = textColor;

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padTop + (plotH * (steps - i)) / steps;

    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();

    const tempVal = Math.round((i * 100) / steps);
    ctx.textAlign = 'right';
    ctx.fillText(`${tempVal}°C`, padLeft - 6, y + 3);

    const powerVal = Math.round((i * 300) / steps);
    ctx.textAlign = 'left';
    ctx.fillText(`${powerVal}W`, padLeft + plotW + 6, y + 3);
  }
  ctx.setLineDash([]);

  // Alarm Line (80°C)
  const y80 = padTop + plotH - (80 / 100) * plotH;
  ctx.beginPath();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
  ctx.lineWidth = 1;
  ctx.moveTo(padLeft, y80);
  ctx.lineTo(padLeft + plotW, y80);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
  ctx.textAlign = 'left';
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillText(fanText('⚠️ 80°C 警戒线', '⚠️ 80°C alert threshold'), padLeft + 6, y80 - 4);

  // Time labels
  ctx.fillStyle = textColor;
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'center';
  const timeLabels = currentFanHistoryRange === '5m' ? ['-5m', '-4m', '-3m', '-2m', '-1m', fanText('现在', 'Now')]
    : currentFanHistoryRange === '30m' ? ['-30m', '-24m', '-18m', '-12m', '-6m', fanText('现在', 'Now')]
    : ['-60m', '-48m', '-36m', '-24m', '-12m', fanText('现在', 'Now')];

  timeLabels.forEach((lbl, idx) => {
    const x = padLeft + (plotW * idx) / (timeLabels.length - 1);
    ctx.fillText(lbl, x, h - 8);
  });

  if (!fanHistoryPoints || fanHistoryPoints.length < 2) {
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(fanText('等待采样数据汇入...', 'Waiting for telemetry samples...'), padLeft + plotW / 2, padTop + plotH / 2);
    return;
  }

  const count = fanHistoryPoints.length;
  const getX = (i) => padLeft + (plotW * i) / (count - 1);
  const getYTemp = (p, key) => {
    if (p[key] === null || p[key] === undefined) return null;
    return padTop + plotH - (Math.max(0, Math.min(100, parseFloat(p[key]) || 0)) / 100) * plotH;
  };
  const getYPower = (p) => {
    if (p.gpuP === null || p.gpuP === undefined) return null;
    return padTop + plotH - (Math.max(0, Math.min(300, parseFloat(p.gpuP) || 0)) / 300) * plotH;
  };

  // GPU Power Curve
  if (fanSeriesVisible.gpuP) {
    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    grad.addColorStop(1, 'rgba(59, 130, 246, 0.01)');
    drawSmoothCurve(ctx, fanHistoryPoints, getX, getYPower, '#3b82f6', 1.8, true, grad, padTop + plotH, padLeft, plotW);
  }

  // CPU Package Temp
  if (fanSeriesVisible.cpu) {
    drawSmoothCurve(ctx, fanHistoryPoints, getX, (p) => getYTemp(p, 'cpu'), '#ef4444', 2.0);
  }

  // GPU Edge Temp
  if (fanSeriesVisible.gpuE) {
    drawSmoothCurve(ctx, fanHistoryPoints, getX, (p) => getYTemp(p, 'gpuE'), '#eab308', 1.6);
  }

  // GPU Junction Temp
  if (fanSeriesVisible.gpuJ) {
    drawSmoothCurve(ctx, fanHistoryPoints, getX, (p) => getYTemp(p, 'gpuJ'), '#f97316', 2.4);
  }
}

function handleChartMouseMove(e) {
  const canvas = document.getElementById('fan-history-canvas');
  const tooltip = document.getElementById('fan-chart-tooltip');
  if (!canvas || !tooltip || !fanHistoryPoints.length) return;

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const padLeft = 42;
  const padRight = 42;
  const plotW = rect.width - padLeft - padRight;

  if (mouseX < padLeft || mouseX > rect.width - padRight) {
    handleChartMouseLeave();
    return;
  }

  const ratio = (mouseX - padLeft) / plotW;
  fanHoverIndex = Math.max(0, Math.min(fanHistoryPoints.length - 1, Math.round(ratio * (fanHistoryPoints.length - 1))));

  const p = fanHistoryPoints[fanHoverIndex];
  if (!p) return;

  const dateObj = new Date(p.t);
  const timeStr = dateObj.toLocaleTimeString();

  tooltip.style.display = 'block';
  tooltip.style.background = 'var(--win-card)';
  tooltip.style.border = '1px solid var(--win-border)';

  const tooltipWidth = 190;
  let posX = mouseX + 14;
  if (posX + tooltipWidth > rect.width - 10) {
    posX = mouseX - tooltipWidth - 14;
  }

  tooltip.style.left = `${Math.max(10, posX)}px`;
  tooltip.style.top = `16px`;
  tooltip.innerHTML = `
    <div style="font-weight: 600; color: var(--win-text-primary); border-bottom: 1px solid var(--win-border); padding-bottom: 3px; margin-bottom: 4px;">
      <span>🕒 ${window.escapeHtml(timeStr)}</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 2px; font-size: 11px;">
      <div style="color: #f97316; display: flex; justify-content: space-between;"><span>${fanText('🟠 GPU 结温:', '🟠 GPU junction:')}</span> <strong>${p.gpuJ !== null ? `${p.gpuJ} °C` : 'N/A'}</strong></div>
      <div style="color: #ef4444; display: flex; justify-content: space-between;"><span>${fanText('🔴 CPU 封装:', '🔴 CPU package:')}</span> <strong>${p.cpu !== null ? `${p.cpu} °C` : 'N/A'}</strong></div>
      <div style="color: #eab308; display: flex; justify-content: space-between;"><span>${fanText('🟡 GPU 核心:', '🟡 GPU edge:')}</span> <strong>${p.gpuE !== null ? `${p.gpuE} °C` : 'N/A'}</strong></div>
      <div style="color: #3b82f6; display: flex; justify-content: space-between;"><span>${fanText('⚡ GPU 功耗:', '⚡ GPU power:')}</span> <strong>${p.gpuP !== null ? `${p.gpuP} W` : 'N/A'}</strong></div>
    </div>
  `;

  drawFanHistoryCanvas();
}

function handleChartMouseLeave() {
  fanHoverIndex = -1;
  const tooltip = document.getElementById('fan-chart-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  drawFanHistoryCanvas();
}

window.loadFanLogs = async function () {
  const box = document.getElementById('fan-logs-content');
  if (!box) return;
  box.innerText = '正在拉取温控服务日志...';
  window.showModal('modal-fan-logs');

  try {
    const res = await window.api.request('/api/fan/logs');
    box.innerText = res.logs || '暂无日志';
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    box.innerText = `加载日志失败: ${err.message}`;
  }
};

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function setProgressBar(id, percent) {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = Math.max(0, Math.min(100, percent));
  el.style.width = `${pct}%`;
  el.className = `win-progress-bar ${pct > 85 ? 'red' : pct > 65 ? 'yellow' : 'green'}`;
}

function setTempColor(id, temp) {
  const el = document.getElementById(id);
  if (el && temp !== null) el.style.color = getTempColorCode(temp);
}

function getTempColorCode(temp) {
  if (temp === null || temp === undefined) return 'inherit';
  if (temp >= 80) return 'var(--perf-red)';
  if (temp >= 65) return 'var(--perf-yellow)';
  return 'var(--perf-green)';
}

window.loadFanStatus = loadFanStatus;
window.loadFanHistory = loadFanHistory;
window.drawFanHistoryCanvas = drawFanHistoryCanvas;
