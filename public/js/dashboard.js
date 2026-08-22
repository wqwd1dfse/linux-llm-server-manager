// Dedicated Hardware Monitors (CPU, GPU, RAM, SSD) & Telemetry

let metricsWs = null;
let latestMetricsData = null;
const dashboardText = (zh, en) => window.localize ? window.localize(zh, en) : en;

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '0 KB/s';
  const kb = bytesPerSec / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB/s`;
  }
  return `${(kb / 1024).toFixed(2)} MB/s`;
}

window.initDashboard = function () {
  connectMetricsWs();
};

window.addEventListener('languagechange', () => {
  if (latestMetricsData) updateMonitorsUI(latestMetricsData);
});

function connectMetricsWs() {
  if (metricsWs && metricsWs.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/metrics`;

  try {
    metricsWs = new WebSocket(wsUrl);

    metricsWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'metrics' && msg.data) {
          updateMonitorsUI(msg.data);
        } else if (msg.type === 'status' && !msg.connected) {
          window.updateConnectionStatus(false);
        }
      } catch (e) {
        console.error('Error parsing metrics WS message:', e);
      }
    };

    metricsWs.onclose = () => {
      setTimeout(connectMetricsWs, 3000);
    };

    metricsWs.onerror = () => {};
  } catch (err) {
    console.error('WebSocket connection failed:', err);
  }
}

function updateMonitorsUI(data) {
  if (!data) return;
  latestMetricsData = data;
  window.updateConnectionStatus(true, data.os?.uptimeFormatted);

  // 1. CPU Detailed Monitor
  const cpuPercent = data.cpu?.usagePercent !== undefined ? data.cpu.usagePercent : 0;
  const cpuVal = document.getElementById('cpu-main-val');
  const cpuModel = document.getElementById('cpu-main-model');
  const cpuSub = document.getElementById('cpu-main-sub');
  const cpuBar = document.getElementById('cpu-main-progress');

  if (cpuVal) cpuVal.innerText = `${cpuPercent}%`;
  if (cpuModel) cpuModel.innerText = data.cpu?.model || 'Generic Linux CPU';
  if (cpuSub) cpuSub.innerText = dashboardText(String(data.cpu?.cores || 1) + ' 物理/逻辑核心 | 时钟速度: ' + (data.cpu?.frequency || '--'), String(data.cpu?.cores || 1) + ' physical/logical cores | Clock: ' + (data.cpu?.frequency || '--'));
  if (cpuBar) {
    cpuBar.style.width = `${Math.max(cpuPercent, 2)}%`;
    cpuBar.className = `win-progress-bar ${cpuPercent > 85 ? 'red' : cpuPercent > 65 ? 'yellow' : 'green'}`;
  }

  // CPU Props
  setText('cpu-prop-model', data.cpu?.model || '--');
  setText('cpu-prop-cores', String(data.cpu?.cores || 1) + ' ' + dashboardText('核心', 'cores'));
  setText('cpu-prop-freq', data.cpu?.frequency || '--');
  setText('cpu-prop-cache', data.cpu?.cache || 'N/A');
  setText('cpu-prop-arch', data.os?.arch || '--');
  setText('cpu-prop-load', data.cpu?.loadavg?.join(' / ') || '--');

  // CPU Top Processes
  const cpuTopTbody = document.getElementById('cpu-top-processes-body');
  if (cpuTopTbody && data.topProcesses) {
    const topCpu = [...data.topProcesses].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    cpuTopTbody.innerHTML = topCpu.map(p => `
      <tr>
        <td style="font-family: var(--font-mono); color: var(--win-accent-light);">${window.escapeHtml(p.pid)}</td>
        <td>${window.escapeHtml(p.user)}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">${window.escapeHtml(p.cpu)}%</td>
        <td style="font-family: var(--font-mono); font-size: 11px;">${window.escapeHtml(p.command)}</td>
      </tr>
    `).join('');
  }

  // 2. GPU Detailed Monitor
  const gpuVal = document.getElementById('gpu-main-val');
  const gpuName = document.getElementById('gpu-main-name');
  const gpuSub = document.getElementById('gpu-main-sub');
  const gpuContainer = document.getElementById('gpu-container-content');

  if (data.gpu?.hasGpu && data.gpu.devices?.length > 0) {
    const firstGpu = data.gpu.devices[0];

    if (firstGpu.isDedicated) {
      if (gpuVal) gpuVal.innerText = firstGpu.utilizationGpu !== null ? String(firstGpu.utilizationGpu) + '%' : dashboardText('在线', 'Online');
      if (gpuName) gpuName.innerText = firstGpu.name;
      if (gpuSub) gpuSub.innerText = 'VRAM: ' + (firstGpu.memoryUsedMb || '--') + ' / ' + (firstGpu.memoryTotalMb || '--') + ' MB | ' + dashboardText('驱动', 'Driver') + ': ' + (firstGpu.driverVersion || 'Generic');

      if (gpuContainer) {
        gpuContainer.innerHTML = data.gpu.devices.map(g => `
          <div class="perf-card">
            <div class="perf-card-title">${window.escapeHtml(g.name)} (GPU #${window.escapeHtml(g.index)})</div>
            <div class="perf-grid-2" style="margin-top: 6px;">
              <div>
                <div class="win-prop-row"><span class="prop-name">核心利用率</span><span class="prop-val">${window.escapeHtml(g.utilizationGpu || 0)}%</span></div>
                <div class="win-progress" style="margin: 4px 0 8px 0;">
                  <div class="win-progress-bar ${(g.utilizationGpu || 0) > 85 ? 'red' : 'green'}" style="width: ${Math.max(g.utilizationGpu || 0, 2)}%;"></div>
                </div>
                <div class="win-prop-row"><span class="prop-name">专用显存 (VRAM)</span><span class="prop-val">${window.escapeHtml(g.memoryUsedMb || '--')} / ${window.escapeHtml(g.memoryTotalMb || '--')} MB</span></div>
                <div class="win-progress" style="margin: 4px 0;">
                  <div class="win-progress-bar yellow" style="width: ${Math.max(g.utilizationMemory || 0, 2)}%;"></div>
                </div>
              </div>
              <div>
                <div class="win-prop-row"><span class="prop-name">核心温度</span><span class="prop-val" style="color: ${(g.temperature || 0) > 75 ? '#f14c4c' : 'inherit'};">${g.temperature !== null ? `${g.temperature} °C` : 'N/A'}</span></div>
                <div class="win-prop-row"><span class="prop-name">功耗 (Power Draw)</span><span class="prop-val">${g.powerDraw ? window.escapeHtml(g.powerDraw) : 'N/A'}</span></div>
                <div class="win-prop-row"><span class="prop-name">显卡驱动程序</span><span class="prop-val">${window.escapeHtml(g.driverVersion || '--')}</span></div>
              </div>
            </div>
          </div>
        `).join('');
      }
    } else {
      if (gpuVal) gpuVal.innerText = dashboardText('正常', 'Healthy');
      if (gpuName) gpuName.innerText = firstGpu.name;
      if (gpuSub) gpuSub.innerText = `${firstGpu.note || '显示适配器'} | ${firstGpu.driverVersion || '--'}`;

      if (gpuContainer) {
        gpuContainer.innerHTML = data.gpu.devices.map(g => `
          <div class="perf-card">
            <div class="perf-card-title">${window.escapeHtml(g.name)}</div>
            <div class="win-prop-row"><span class="prop-name">设备类型</span><span class="prop-val">${window.escapeHtml(g.note || '显示适配器')}</span></div>
            <div class="win-prop-row"><span class="prop-name">图形驱动</span><span class="prop-val">${window.escapeHtml(g.driverVersion || '--')}</span></div>
            <div class="win-prop-row"><span class="prop-name">状态</span><span class="prop-val" style="color: var(--perf-green);">正常</span></div>
          </div>
        `).join('');
      }
    }
  } else {
    if (gpuVal) gpuVal.innerText = dashboardText('无独显', 'No discrete GPU');
    if (gpuName) gpuName.innerText = dashboardText('未检测到独立显卡 (Headless / 标准服务器)', 'No discrete GPU detected (headless / standard server)');
    if (gpuSub) gpuSub.innerText = dashboardText('可安装独立加速卡驱动后实时采集 GPU 算力指标', 'Install an accelerator driver to collect live GPU telemetry');
    if (gpuContainer) {
      gpuContainer.innerHTML = `
        <div class="perf-card" style="padding: 24px; text-align: center; color: var(--win-text-secondary);">
          <div style="font-size: 28px; margin-bottom: 8px;">🎮</div>
          <div style="font-size: 13px; color: var(--win-text-primary); font-weight: 600;">当前服务器未检测到活动独立显卡传感器</div>
        </div>
      `;
    }
  }

  // 3. RAM Detailed Monitor
  const memPercent = data.memory?.usagePercent !== undefined ? data.memory.usagePercent : 0;
  const ramVal = document.getElementById('ram-main-val');
  const ramUsage = document.getElementById('ram-main-usage');
  const ramAvail = document.getElementById('ram-main-avail');
  const ramBar = document.getElementById('ram-main-progress');

  if (ramVal) ramVal.innerText = `${memPercent}%`;
  if (ramUsage) ramUsage.innerText = `${formatBytes(data.memory?.used)} / ${formatBytes(data.memory?.total)}`;
  if (ramAvail) ramAvail.innerText = dashboardText('可用容量: ', 'Available: ') + formatBytes(data.memory?.available);
  if (ramBar) {
    ramBar.style.width = `${Math.max(memPercent, 2)}%`;
    ramBar.className = `win-progress-bar ${memPercent > 85 ? 'red' : memPercent > 65 ? 'yellow' : 'green'}`;
  }

  // RAM Props
  setText('ram-prop-total', formatBytes(data.memory?.total));
  setText('ram-prop-used', `${formatBytes(data.memory?.used)} (${memPercent}%)`);
  setText('ram-prop-avail', formatBytes(data.memory?.available));
  setText('ram-prop-free', formatBytes(data.memory?.free));
  setText('ram-prop-cached', formatBytes(data.memory?.cached));
  setText('ram-prop-buffers', formatBytes(data.memory?.buffers));
  setText('ram-prop-slab', formatBytes(data.memory?.slab || 0));
  setText('ram-prop-swap', `${formatBytes(data.memory?.swapUsed)} / ${formatBytes(data.memory?.swapTotal)} (${data.memory?.swapPercent || 0}%)`);

  // RAM Top Processes
  const ramTopTbody = document.getElementById('ram-top-processes-body');
  if (ramTopTbody && data.topProcesses) {
    const topRam = [...data.topProcesses].sort((a, b) => b.mem - a.mem).slice(0, 5);
    ramTopTbody.innerHTML = topRam.map(p => `
      <tr>
        <td style="font-family: var(--font-mono); color: var(--win-accent-light);">${window.escapeHtml(p.pid)}</td>
        <td>${window.escapeHtml(p.user)}</td>
        <td style="font-family: var(--font-mono); font-weight: 600;">${window.escapeHtml(p.mem)}%</td>
        <td style="font-family: var(--font-mono); font-size: 11px;">${window.escapeHtml(p.command)}</td>
      </tr>
    `).join('');
  }

  // 4. SSD / Storage Detailed Monitor
  const readSpeed = data.disk?.readSpeed || 0;
  const writeSpeed = data.disk?.writeSpeed || 0;
  setText('ssd-main-io', dashboardText('读: ', 'Read: ') + formatSpeed(readSpeed) + dashboardText(' | 写: ', ' | Write: ') + formatSpeed(writeSpeed));
  setText('ssd-main-total', `${formatBytes(data.disk?.used)} / ${formatBytes(data.disk?.total)} (${data.disk?.overallPercent || 0}%)`);

  const diskDevicesBody = document.getElementById('disk-devices-body');
  if (diskDevicesBody) {
    diskDevicesBody.replaceChildren();
    const devices = Array.isArray(data.disk?.devices) ? data.disk.devices : [];

    if (devices.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.style.textAlign = 'center';
      cell.style.color = 'var(--win-text-muted)';
      cell.textContent = dashboardText('未检测到物理磁盘设备', 'No physical disk devices detected');
      row.appendChild(cell);
      diskDevicesBody.appendChild(row);
    } else {
      for (const device of devices) {
        const row = document.createElement('tr');
        const model = [device.vendor, device.model].filter(Boolean).join(' ') || '--';
        const transport = device.transport && device.transport !== 'unknown'
          ? device.transport.toUpperCase()
          : dashboardText('未知', 'Unknown');
        const media = device.rotational === true
          ? 'HDD'
          : device.rotational === false
            ? 'SSD'
            : dashboardText('未知', 'Unknown');
        const values = [
          device.path || ('/dev/' + device.name),
          model,
          transport,
          formatBytes(device.size),
          media,
          device.serial || '--'
        ];

        values.forEach((value, index) => {
          const cell = document.createElement('td');
          cell.textContent = String(value);
          if (index === 0 || index === 5) cell.style.fontFamily = 'var(--font-mono)';
          if (index === 0) cell.style.fontWeight = '600';
          row.appendChild(cell);
        });
        diskDevicesBody.appendChild(row);
      }
    }
  }
  const ssdTbody = document.getElementById('ssd-table-body');
  if (ssdTbody && data.disk?.partitions) {
    if (data.disk.partitions.length === 0) {
      ssdTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--win-text-muted);">未发现挂载的磁盘卷</td></tr>';
    } else {
      ssdTbody.innerHTML = data.disk.partitions.map(d => `
        <tr>
          <td style="font-weight: 600; font-family: var(--font-mono); color: var(--win-text-primary);">${window.escapeHtml(d.mount)}</td>
          <td style="color: var(--win-text-secondary); font-family: var(--font-mono);">${window.escapeHtml(d.filesystem)}</td>
          <td>${formatBytes(d.total)}</td>
          <td>${formatBytes(d.used)}</td>
          <td>${formatBytes(d.available)}</td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <div class="win-progress" style="width: 70px; height: 8px;">
                <div class="win-progress-bar ${d.percent > 85 ? 'red' : d.percent > 65 ? 'yellow' : 'green'}" style="width: ${d.percent}%;"></div>
              </div>
              <span style="font-size: 11px; font-family: var(--font-mono);">${window.escapeHtml(d.percent)}%</span>
            </div>
          </td>
          <td style="font-family: var(--font-mono); font-size: 11px; color: var(--win-text-secondary);">
            ${d.inodes ? `${window.escapeHtml(d.inodes.used)}/${window.escapeHtml(d.inodes.total)} (${window.escapeHtml(d.inodes.percent)})` : '-'}
          </td>
        </tr>
      `).join('');
    }
  }

  // Bottom Status Bar
  setText('statusbar-cpu', `CPU: ${cpuPercent}%`);
  setText('statusbar-ram', `RAM: ${memPercent}% (${formatBytes(data.memory?.used)})`);
  setText('statusbar-net', `Net: ↓ ${formatSpeed(data.network?.rxSpeed || 0)} ↑ ${formatSpeed(data.network?.txSpeed || 0)}`);
  if (data.os?.uptimeFormatted) {
    setText('statusbar-uptime', dashboardText('开机: ', 'Uptime: ') + data.os.uptimeFormatted);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}
