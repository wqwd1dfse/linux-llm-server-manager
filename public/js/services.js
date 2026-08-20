// Services & Processes Management

window.initServices = function () {
  loadProcesses();
  loadSystemdServices();

  document.getElementById('btn-refresh-processes')?.addEventListener('click', loadProcesses);
  document.getElementById('btn-refresh-systemd')?.addEventListener('click', loadSystemdServices);
};

async function loadProcesses() {
  const tbody = document.getElementById('process-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted);">正在获取进程...</td></tr>';

  try {
    const res = await window.api.request('/api/services/processes?limit=50');
    if (!res.processes || res.processes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted); padding: 30px;">无活跃进程</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const p of res.processes) {
      const tr = document.createElement('tr');

      const tdPid = document.createElement('td');
      tdPid.style.fontFamily = 'var(--font-mono)';
      tdPid.style.fontWeight = '600';
      tdPid.style.color = 'var(--win-accent)';
      tdPid.textContent = String(p.pid);
      tr.appendChild(tdPid);

      const tdUser = document.createElement('td');
      tdUser.style.color = 'var(--win-text-primary)';
      tdUser.textContent = p.user;
      tr.appendChild(tdUser);

      const tdCpu = document.createElement('td');
      tdCpu.style.fontFamily = 'var(--font-mono)';
      tdCpu.style.fontWeight = '600';
      tdCpu.textContent = `${p.cpu}%`;
      tr.appendChild(tdCpu);

      const tdMem = document.createElement('td');
      tdMem.style.fontFamily = 'var(--font-mono)';
      tdMem.textContent = `${p.mem}%`;
      tr.appendChild(tdMem);

      const tdCmd = document.createElement('td');
      tdCmd.style.fontFamily = 'var(--font-mono)';
      tdCmd.style.fontSize = '12px';
      tdCmd.style.maxWidth = '280px';
      tdCmd.style.overflow = 'hidden';
      tdCmd.style.textOverflow = 'ellipsis';
      tdCmd.style.whiteSpace = 'nowrap';
      tdCmd.style.color = 'var(--win-text-primary)';
      tdCmd.title = p.args || p.command;
      tdCmd.textContent = p.args || p.command;
      tr.appendChild(tdCmd);

      const tdActions = document.createElement('td');
      const btnKill = document.createElement('button');
      btnKill.className = 'cmd-btn btn-sm danger';
      btnKill.textContent = '终止';
      btnKill.addEventListener('click', () => killProcess(p.pid));
      tdActions.appendChild(btnKill);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--perf-red); padding: 30px;">获取进程失败: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

async function killProcess(pid) {
  if (!confirm(`确定要强制终止 PID 为 ${pid} 的进程吗？`)) return;

  try {
    await window.api.request('/api/services/processes/kill', {
      method: 'POST',
      body: JSON.stringify({ pid, signal: '9' })
    });
    window.toast(`进程 ${pid} 已成功终止`, 'success');
    loadProcesses();
  } catch (_) {}
}

async function loadSystemdServices() {
  const tbody = document.getElementById('systemd-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--win-text-muted);">正在获取 Systemd 服务...</td></tr>';

  try {
    const res = await window.api.request('/api/services/systemd');
    if (!res.services || res.services.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--win-text-muted); padding: 30px;">未发现服务</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const s of res.services.slice(0, 100)) {
      const tr = document.createElement('tr');
      const isRunning = s.isRunning;

      const tdName = document.createElement('td');
      tdName.style.fontWeight = '600';
      tdName.style.fontFamily = 'var(--font-mono)';
      tdName.style.color = 'var(--win-accent)';
      tdName.textContent = s.name;
      tr.appendChild(tdName);

      const tdStatus = document.createElement('td');
      tdStatus.style.fontWeight = '500';
      tdStatus.style.color = isRunning ? 'var(--perf-green)' : 'var(--win-text-muted)';
      tdStatus.textContent = `${isRunning ? '● 运行中' : '○ 已停止'} (${s.sub})`;
      tr.appendChild(tdStatus);

      const tdDesc = document.createElement('td');
      tdDesc.style.fontSize = '12px';
      tdDesc.style.color = 'var(--win-text-secondary)';
      tdDesc.style.maxWidth = '240px';
      tdDesc.style.overflow = 'hidden';
      tdDesc.style.textOverflow = 'ellipsis';
      tdDesc.style.whiteSpace = 'nowrap';
      tdDesc.title = s.description;
      tdDesc.textContent = s.description;
      tr.appendChild(tdDesc);

      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.style.display = 'flex';
      actionGroup.style.gap = '4px';

      if (isRunning) {
        const btnStop = document.createElement('button');
        btnStop.className = 'cmd-btn btn-sm danger';
        btnStop.textContent = '停止';
        btnStop.addEventListener('click', () => controlSystemd(s.name, 'stop'));
        actionGroup.appendChild(btnStop);
      } else {
        const btnStart = document.createElement('button');
        btnStart.className = 'cmd-btn btn-sm';
        btnStart.style.color = 'var(--perf-green)';
        btnStart.textContent = '启动';
        btnStart.addEventListener('click', () => controlSystemd(s.name, 'start'));
        actionGroup.appendChild(btnStart);
      }

      const btnRestart = document.createElement('button');
      btnRestart.className = 'cmd-btn btn-sm';
      btnRestart.textContent = '重启';
      btnRestart.addEventListener('click', () => controlSystemd(s.name, 'restart'));
      actionGroup.appendChild(btnRestart);

      tdActions.appendChild(actionGroup);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--perf-red); padding: 30px;">获取系统服务失败: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

async function controlSystemd(name, action) {
  try {
    await window.api.request('/api/services/systemd/control', {
      method: 'POST',
      body: JSON.stringify({ name, action })
    });
    window.toast(`服务 ${name} 已执行 ${action}`, 'success');
    loadSystemdServices();
  } catch (_) {}
}
