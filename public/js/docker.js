// Docker Container & Image Management

let currentViewingContainerId = null;
let dockerStatusRequestSequence = 0;
let dockerContainersRequestSequence = 0;
let dockerImagesRequestSequence = 0;
let dockerLogsRequestSequence = 0;
const dockerText = (zh, en) => window.localize ? window.localize(zh, en) : en;

window.initDocker = function () {
  loadDockerStatus();
  loadDockerContainers();
  loadDockerImages();

  document.getElementById('btn-refresh-docker')?.addEventListener('click', loadDockerContainers);
  document.getElementById('btn-refresh-images')?.addEventListener('click', loadDockerImages);

  document.getElementById('btn-docker-pull-modal')?.addEventListener('click', () => {
    const pullInput = document.getElementById('pull-image-name');
    if (pullInput) pullInput.value = '';
    window.showModal('modal-pull-image');
  });

  document.getElementById('btn-confirm-pull')?.addEventListener('click', handlePullImage);
  document.getElementById('btn-refresh-logs')?.addEventListener('click', () => {
    if (currentViewingContainerId) {
      loadContainerLogs(currentViewingContainerId);
    }
  });
};

window.loadDockerContainers = loadDockerContainers;

window.addEventListener('servercontextchange', () => {
  dockerStatusRequestSequence += 1;
  dockerContainersRequestSequence += 1;
  dockerImagesRequestSequence += 1;
  dockerLogsRequestSequence += 1;
  currentViewingContainerId = null;
  document.getElementById('docker-table-body')?.replaceChildren();
  document.getElementById('docker-images-body')?.replaceChildren();
  const logs = document.getElementById('docker-logs-content');
  if (logs) logs.textContent = '';
  window.closeModal?.('modal-docker-logs');
  queueMicrotask(() => Promise.allSettled([
    loadDockerStatus(), loadDockerContainers(), loadDockerImages()
  ]));
});

window.addEventListener('languagechange', () => {
  if (window.currentView !== 'docker') return;
  loadDockerStatus();
  loadDockerContainers();
  loadDockerImages();
});

async function loadDockerStatus() {
  const badge = document.getElementById('docker-version-badge');
  const requestSequence = ++dockerStatusRequestSequence;
  const requestEpoch = window.getServerContextEpoch?.() ?? 0;
  try {
    const res = await window.api.request('/api/docker/status');
    if (requestSequence !== dockerStatusRequestSequence
      || requestEpoch !== (window.getServerContextEpoch?.() ?? 0)) return;
    if (res.installed) {
      badge.textContent = `Docker v${res.version || 'OK'}`;
      badge.style.color = '#34d399';
    } else {
      badge.textContent = '未安装 / 未运行';
      badge.style.color = '#f87171';
    }
  } catch (_) {
    if (requestSequence !== dockerStatusRequestSequence) return;
    if (badge) badge.textContent = '检测失败';
  }
}

async function loadDockerContainers() {
  const tbody = document.getElementById('docker-table-body');
  if (!tbody) return;
  const requestSequence = ++dockerContainersRequestSequence;
  const requestEpoch = window.getServerContextEpoch?.() ?? 0;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted);">正在加载 Docker 容器...</td></tr>';

  try {
    const res = await window.api.request('/api/docker/containers');
    if (requestSequence !== dockerContainersRequestSequence
      || requestEpoch !== (window.getServerContextEpoch?.() ?? 0)) return;
    if (!res.containers || res.containers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted); padding: 30px;">未发现任何 Docker 容器</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const c of res.containers) {
      const isUp = c.isRunning;
      const cleanName = (c.names || '').replace(/^\//, '');

      const tr = document.createElement('tr');

      // Name
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '600';
      tdName.style.color = 'var(--win-accent)';
      tdName.style.fontFamily = 'var(--font-mono)';
      tdName.textContent = cleanName;
      tr.appendChild(tdName);

      // Image
      const tdImg = document.createElement('td');
      tdImg.style.fontFamily = 'var(--font-mono)';
      tdImg.style.fontSize = '12px';
      tdImg.textContent = c.image;
      tr.appendChild(tdImg);

      // Status
      const tdStatus = document.createElement('td');
      tdStatus.style.fontWeight = '500';
      tdStatus.style.color = isUp ? 'var(--perf-green)' : 'var(--win-text-muted)';
      tdStatus.textContent = `${isUp ? '● 运行中' : '○ 已停止'} (${c.status})`;
      tr.appendChild(tdStatus);

      // Ports
      const tdPorts = document.createElement('td');
      tdPorts.style.fontFamily = 'var(--font-mono)';
      tdPorts.style.fontSize = '12px';
      tdPorts.textContent = c.ports || '-';
      tr.appendChild(tdPorts);

      // Stats
      const tdStats = document.createElement('td');
      tdStats.style.fontFamily = 'var(--font-mono)';
      tdStats.style.fontSize = '12px';
      tdStats.textContent = c.stats ? `${c.stats.cpuPerc} | ${c.stats.memUsage}` : '--';
      tr.appendChild(tdStats);

      // Actions
      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.style.display = 'flex';
      actionGroup.style.gap = '4px';

      if (isUp) {
        const btnStop = document.createElement('button');
        btnStop.className = 'cmd-btn btn-sm danger';
        btnStop.textContent = '停止';
        btnStop.addEventListener('click', () => dockerAction(c.id, 'stop'));
        actionGroup.appendChild(btnStop);
      } else {
        const btnStart = document.createElement('button');
        btnStart.className = 'cmd-btn btn-sm';
        btnStart.style.color = 'var(--perf-green)';
        btnStart.textContent = '启动';
        btnStart.addEventListener('click', () => dockerAction(c.id, 'start'));
        actionGroup.appendChild(btnStart);
      }

      const btnRestart = document.createElement('button');
      btnRestart.className = 'cmd-btn btn-sm';
      btnRestart.textContent = '重启';
      btnRestart.addEventListener('click', () => dockerAction(c.id, 'restart'));
      actionGroup.appendChild(btnRestart);

      const btnLogs = document.createElement('button');
      btnLogs.className = 'cmd-btn btn-sm';
      btnLogs.textContent = '日志';
      btnLogs.addEventListener('click', () => viewDockerLogs(c.id, cleanName));
      actionGroup.appendChild(btnLogs);

      const btnRm = document.createElement('button');
      btnRm.className = 'cmd-btn btn-sm danger';
      btnRm.textContent = '删除';
      btnRm.addEventListener('click', () => dockerAction(c.id, 'rm'));
      actionGroup.appendChild(btnRm);

      tdActions.appendChild(actionGroup);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (err) {
    if (requestSequence !== dockerContainersRequestSequence) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--perf-red); padding: 30px;">' + dockerText('获取容器列表失败: ', 'Failed to load containers: ') + window.escapeHtml(err.message) + '</td></tr>';
  }
}

async function dockerAction(id, action) {
  if (action === 'rm' && !confirm(`确定要强制删除容器 ${id} 吗？`)) {
    return;
  }

  try {
    await window.api.request(`/api/docker/containers/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    window.toast(`容器已执行 ${action}`, 'success');
    loadDockerContainers();
  } catch (_) {}
}

async function viewDockerLogs(id, name) {
  currentViewingContainerId = id;
  const nameEl = document.getElementById('docker-logs-name');
  if (nameEl) nameEl.textContent = name || id;
  window.showModal('modal-docker-logs');
  await loadContainerLogs(id);
}

async function loadContainerLogs(id) {
  const box = document.getElementById('docker-logs-content');
  if (!box) return;
  const requestSequence = ++dockerLogsRequestSequence;
  const requestEpoch = window.getServerContextEpoch?.() ?? 0;
  box.textContent = '正在拉取日志...';
  try {
    const res = await window.api.request(`/api/docker/containers/${encodeURIComponent(id)}/logs?tail=200`);
    if (requestSequence !== dockerLogsRequestSequence
      || requestEpoch !== (window.getServerContextEpoch?.() ?? 0)
      || currentViewingContainerId !== id) return;
    box.textContent = res.logs || '无日志输出';
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    if (requestSequence !== dockerLogsRequestSequence) return;
    box.textContent = `加载日志失败: ${err.message}`;
  }
}

async function loadDockerImages() {
  const tbody = document.getElementById('docker-images-body');
  if (!tbody) return;
  const requestSequence = ++dockerImagesRequestSequence;
  const requestEpoch = window.getServerContextEpoch?.() ?? 0;

  try {
    const res = await window.api.request('/api/docker/images');
    if (requestSequence !== dockerImagesRequestSequence
      || requestEpoch !== (window.getServerContextEpoch?.() ?? 0)) return;
    if (!res.images || res.images.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted); padding: 30px;">暂无本地镜像</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const img of res.images) {
      const tr = document.createElement('tr');

      const tdRepo = document.createElement('td');
      tdRepo.style.fontWeight = '600';
      tdRepo.style.fontFamily = 'var(--font-mono)';
      tdRepo.textContent = img.repository;
      tr.appendChild(tdRepo);

      const tdTag = document.createElement('td');
      const tagSpan = document.createElement('span');
      tagSpan.className = 'titlebar-host-badge';
      tagSpan.style.padding = '2px 6px';
      tagSpan.textContent = img.tag;
      tdTag.appendChild(tagSpan);
      tr.appendChild(tdTag);

      const tdId = document.createElement('td');
      tdId.style.fontFamily = 'var(--font-mono)';
      tdId.style.fontSize = '12px';
      tdId.style.color = 'var(--win-text-secondary)';
      tdId.textContent = (img.id || '').slice(0, 12);
      tr.appendChild(tdId);

      const tdCreated = document.createElement('td');
      tdCreated.style.color = 'var(--win-text-secondary)';
      tdCreated.textContent = img.createdSince;
      tr.appendChild(tdCreated);

      const tdSize = document.createElement('td');
      tdSize.style.fontFamily = 'var(--font-mono)';
      tdSize.style.fontSize = '12px';
      tdSize.textContent = img.size;
      tr.appendChild(tdSize);

      const tdActions = document.createElement('td');
      const btnDel = document.createElement('button');
      btnDel.className = 'cmd-btn btn-sm danger';
      btnDel.textContent = '删除';
      btnDel.addEventListener('click', () => deleteDockerImage(img.id));
      tdActions.appendChild(btnDel);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (err) {
    if (requestSequence !== dockerImagesRequestSequence) return;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--perf-red); padding: 30px;">获取镜像失败: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

async function handlePullImage() {
  const input = document.getElementById('pull-image-name');
  const imageName = input?.value?.trim();
  if (!imageName) return window.toast('请输入镜像名称', 'warning');

  window.toast(`正在拉取镜像: ${imageName}...`, 'info');
  window.closeModal('modal-pull-image');

  try {
    const res = await window.api.request('/api/docker/images/pull', {
      method: 'POST',
      body: JSON.stringify({ imageName })
    });
    window.toast(res.message || '镜像拉取成功', 'success');
    loadDockerImages();
  } catch (_) {}
}

async function deleteDockerImage(imageId) {
  if (!confirm(`确定删除镜像 ${imageId} 吗？`)) return;

  try {
    await window.api.request('/api/docker/images/delete', {
      method: 'POST',
      body: JSON.stringify({ imageId, force: false })
    });
    window.toast('镜像已成功删除', 'success');
    loadDockerImages();
  } catch (_) {}
}
