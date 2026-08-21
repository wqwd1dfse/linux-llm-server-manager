// Large Language Model (LLM) Console & Hugging Face Hub Manager

let currentLlmStatus = null;
let chatHistory = [];
let isGenerating = false;
let abortController = null;
let llmPollingTimer = null;
let hfCurrentRepo = null;
let hfMirrorEnabled = false;
const localModelMetadata = new Map();
const LLM_LAUNCH_SETTINGS_KEY = 'llm_launch_settings_v1';
const LLM_LAUNCH_PRESETS = {
  balanced: { ngl: 999, ctx: 32768, ctk: 'q8_0', ctv: 'q8_0', threads: '', parallel: 1, fa: true },
  'low-vram': { ngl: 999, ctx: 16384, ctk: 'q4_0', ctv: 'q4_0', threads: '', parallel: 1, fa: true },
  'long-context': { ngl: 999, ctx: 131072, ctk: 'q4_0', ctv: 'q4_0', threads: '', parallel: 1, fa: true },
  throughput: { ngl: 999, ctx: 32768, ctk: 'q8_0', ctv: 'q8_0', threads: '', parallel: 4, fa: true }
};
function getLlmHost() {
  return window.serverConnectionConfig?.host || window.location.hostname || '127.0.0.1';
}


window.initLLM = function () {
  setupLLMTabs();
  setupChatControls();
  setupLLMModals();
  setupHFExplorer();
  setupLocalModelsManager();
  setupDownloadManager();

  loadLLMStatus();
  loadLocalModelsList();

  startLlmPolling();
};

function startLlmPolling() {
  if (llmPollingTimer) clearTimeout(llmPollingTimer);
  const poll = async () => {
    if (window.currentView === 'llm' && !document.hidden) {
      const activeTab = document.querySelector('.llm-nav-tab.active')?.getAttribute('data-tab');
      if (activeTab === 'chat' || !activeTab) {
        await loadLLMStatus(false);
      } else if (activeTab === 'tasks') {
        await loadDownloadTasks(false);
      }
    }
    llmPollingTimer = setTimeout(poll, window.getPollingInterval?.() || 2500);
  };
  llmPollingTimer = setTimeout(poll, window.getPollingInterval?.() || 2500);
}

window.addEventListener('preferenceschange', startLlmPolling);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && window.currentView === 'llm') startLlmPolling();
});

// 1. Tab Switching
function setupLLMTabs() {
  document.querySelectorAll('.llm-nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.getAttribute('data-tab');
      document.querySelectorAll('.llm-nav-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.llm-tab-content').forEach(c => c.classList.toggle('active', c.id === `llm-tab-${targetTab}`));

      if (targetTab === 'local') loadLocalModelsList();
      if (targetTab === 'hf') {
        const queryInput = document.getElementById('hf-search-query');
        if (queryInput && !queryInput.value) searchHFModels('gguf');
      }
      if (targetTab === 'tasks') loadDownloadTasks();
    });
  });
}

// 2. LLM Service Status
async function loadLLMStatus(showToast = true) {
  try {
    const res = await window.api.request('/api/llm/status');
    currentLlmStatus = res.data;
    renderLLMStatus(currentLlmStatus);
  } catch (err) {
    if (showToast) console.error('Failed to load LLM status:', err);
  }
}

function renderLLMStatus(status) {
  const badge = document.getElementById('llm-status-badge');
  const modelName = document.getElementById('llm-active-model-name');
  const endpoint = document.getElementById('llm-active-port');
  const cmd = document.getElementById('llm-active-cmd');
  const chatModelTitle = document.getElementById('chat-model-title-badge');

  const btnStart = document.getElementById('btn-llm-start-modal');
  const btnRestart = document.getElementById('btn-llm-restart');
  const btnStop = document.getElementById('btn-llm-stop');
  const uptime = document.getElementById('llm-active-uptime');
  const params = document.getElementById('llm-active-params');
  const resources = document.getElementById('llm-active-resources');

  if (status.isRunning) {
    if (badge) {
      badge.innerText = '● 正在运行 (Running)';
      badge.style.color = 'var(--perf-green)';
    }
    if (modelName) modelName.innerText = status.modelName;
    if (chatModelTitle) chatModelTitle.innerText = status.modelName;
    if (endpoint) endpoint.innerText = `http://${getLlmHost()}:${status.port}`;
    if (cmd) cmd.innerText = status.processInfo?.launchCmd || '--';
    const runtime = status.runtimeInfo || {};
    if (uptime) uptime.innerText = formatDuration(runtime.uptimeMs);
    if (params) {
      const parts = [
        runtime.context ? `${Number(runtime.context).toLocaleString()} ctx` : null,
        runtime.parallel ? `${runtime.parallel} slots` : null,
        runtime.cacheTypeK ? `KV ${runtime.cacheTypeK}/${runtime.cacheTypeV}` : null,
        runtime.flashAttention === true ? 'FA on' : runtime.flashAttention === false ? 'FA off' : null
      ].filter(Boolean);
      params.innerText = parts.join(' · ') || '外部启动，参数未知';
    }
    if (resources) {
      resources.innerText = status.processInfo
        ? `PID ${status.processInfo.pid} · CPU ${status.processInfo.cpu}% · MEM ${status.processInfo.mem}%`
        : '--';
    }

    if (btnStart) btnStart.style.display = 'none';
    if (btnRestart) btnRestart.style.display = 'inline-flex';
    if (btnStop) btnStop.style.display = 'inline-flex';

    renderSlots(status.slots);
  } else {
    if (badge) {
      badge.innerText = '○ 未运行 (Stopped)';
      badge.style.color = 'var(--win-text-muted)';
    }
    if (modelName) modelName.innerText = '未加载模型';
    if (chatModelTitle) chatModelTitle.innerText = '服务未启动';
    if (endpoint) endpoint.innerText = `http://${getLlmHost()}:8080`;
    if (cmd) cmd.innerText = '等待启动 llama-server 推理服务...';
    if (uptime) uptime.innerText = '--';
    if (params) params.innerText = '--';
    if (resources) resources.innerText = '--';

    if (btnStart) btnStart.style.display = 'inline-flex';
    if (btnRestart) btnRestart.style.display = 'none';
    if (btnStop) btnStop.style.display = 'none';

    renderSlots(null);
  }
}

function renderSlots(slots) {
  const container = document.getElementById('llm-slots-container');
  if (!container) return;

  if (!slots || slots.length === 0) {
    container.innerHTML = `<div style="color: var(--win-text-muted); font-size: 11px; text-align: center; padding: 10px;">暂无活跃推理任务</div>`;
    return;
  }

  container.innerHTML = slots.map(s => {
    const isBusy = s.state === 1 || s.state === 'processing';
    return `
      <div class="slot-item">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-family: var(--font-mono); font-size: 11px; font-weight: 600;">Slot #${window.escapeHtml(s.id)}</span>
          <span style="font-size: 10px; color: ${isBusy ? 'var(--perf-yellow)' : 'var(--perf-green)'}; font-weight: 600;">
            ${isBusy ? '⚡ 正在生成' : '● 空闲待命'}
          </span>
        </div>
        <div style="font-size: 10px; color: var(--win-text-secondary); margin-top: 2px;">
          上下文: ${window.escapeHtml(s.n_ctx || s.n_past || 0)} tokens | 提示词缓存: ${window.escapeHtml(s.n_prompt_tokens || 0)}
        </div>
      </div>
    `;
  }).join('');
}

// 3. Local Models Management
async function loadLocalModelsList() {
  const tbody = document.getElementById('local-models-table-body');
  const diskBar = document.getElementById('local-disk-progress');
  const diskText = document.getElementById('local-disk-summary-text');

  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--win-text-muted); padding: 20px;">正在扫描本地模型...</td></tr>';

  try {
    const res = await window.api.request('/api/llm/local-models');
    const { disk, models } = res.data;
    localModelMetadata.clear();
    for (const model of models) {
      localModelMetadata.set(model.path, model);
    }

    if (diskText && disk) {
      diskText.innerText = `存储空间: 已用 ${disk.used} / 总计 ${disk.total} (剩余 ${disk.free} 可用)`;
    }
    if (diskBar && disk) {
      const pct = parseInt(disk.percent.replace('%', ''), 10) || 0;
      diskBar.style.width = `${pct}%`;
      diskBar.className = `win-progress-bar ${pct > 85 ? 'red' : pct > 65 ? 'yellow' : 'green'}`;
    }

    if (!tbody) return;
    if (models.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--win-text-muted); padding: 30px;">未发现本地模型文件，您可以在「Hugging Face 云端模型库」一键下载！</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const m of models) {
      const tr = document.createElement('tr');
      tr.className = 'local-model-row';
      tr.setAttribute('data-name', (m.name || '').toLowerCase());
      tr.setAttribute('data-quant', (m.quant || '').toLowerCase());
      if (m.isActive) tr.style.backgroundColor = 'rgba(16, 185, 129, 0.08)';

      const tdName = document.createElement('td');
      const nameBox = document.createElement('div');
      nameBox.style.display = 'flex';
      nameBox.style.alignItems = 'center';
      nameBox.style.gap = '8px';

      const titleDiv = document.createElement('div');
      titleDiv.style.fontWeight = '600';
      titleDiv.style.color = 'var(--win-text-primary)';
      titleDiv.style.fontFamily = 'var(--font-mono)';
      titleDiv.style.fontSize = '13px';
      titleDiv.textContent = m.name;
      nameBox.appendChild(titleDiv);

      if (m.isActive) {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'titlebar-host-badge';
        activeBadge.style.backgroundColor = 'var(--perf-green)';
        activeBadge.style.color = '#fff';
        activeBadge.style.fontSize = '9px';
        activeBadge.style.fontWeight = '600';
        activeBadge.textContent = '🟢 正在运行中';
        nameBox.appendChild(activeBadge);
      }
      tdName.appendChild(nameBox);

      const pathBox = document.createElement('div');
      pathBox.style.fontSize = '10px';
      pathBox.style.color = 'var(--win-text-secondary)';
      pathBox.style.marginTop = '2px';
      pathBox.style.display = 'flex';
      pathBox.style.alignItems = 'center';
      pathBox.style.gap = '6px';

      const pathSpan = document.createElement('span');
      pathSpan.textContent = `路径: ${m.path}`;
      pathBox.appendChild(pathSpan);

      const btnCopy = document.createElement('button');
      btnCopy.className = 'cmd-btn btn-sm';
      btnCopy.style.fontSize = '9px';
      btnCopy.style.padding = '1px 4px';
      btnCopy.textContent = '📋 复制路径';
      btnCopy.addEventListener('click', () => window.copyModelPath(m.path));
      pathBox.appendChild(btnCopy);

      tdName.appendChild(pathBox);
      tr.appendChild(tdName);

      const tdQuant = document.createElement('td');
      tdQuant.innerHTML = `<span class="titlebar-host-badge" style="font-size: 10px;">${window.escapeHtml(m.quant)}</span>`;
      tr.appendChild(tdQuant);

      const tdSize = document.createElement('td');
      tdSize.style.fontFamily = 'var(--font-mono)';
      tdSize.style.fontWeight = '600';
      tdSize.textContent = m.sizeFormatted;
      tr.appendChild(tdSize);

      const tdMod = document.createElement('td');
      tdMod.style.fontSize = '11px';
      tdMod.style.color = 'var(--win-text-secondary)';
      tdMod.textContent = m.modified;
      tr.appendChild(tdMod);

      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.style.display = 'flex';
      actionGroup.style.gap = '6px';

      if (m.isActive) {
        const btnChat = document.createElement('button');
        btnChat.className = 'cmd-btn primary btn-sm';
        btnChat.textContent = '💬 去对话';
        btnChat.addEventListener('click', () => {
          document.querySelector('.llm-nav-tab[data-tab="chat"]')?.click();
        });
        actionGroup.appendChild(btnChat);
      } else {
        const btnRun = document.createElement('button');
        btnRun.className = 'cmd-btn primary btn-sm';
        btnRun.textContent = '🚀 运行';
        btnRun.addEventListener('click', () => runLocalModelDirectly(m.path, m.name));
        actionGroup.appendChild(btnRun);
      }

      const btnConfig = document.createElement('button');
      btnConfig.className = 'cmd-btn btn-sm';
      btnConfig.textContent = '⚙️ 参数';
      btnConfig.addEventListener('click', () => openStartModalWithFile(m.path, m.name, m.sizeBytes));
      actionGroup.appendChild(btnConfig);

      const btnDel = document.createElement('button');
      btnDel.className = 'cmd-btn danger btn-sm';
      btnDel.textContent = '🗑️';
      btnDel.addEventListener('click', () => deleteLocalModel(m.path, m.name));
      actionGroup.appendChild(btnDel);

      tdActions.appendChild(actionGroup);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }

    const filterInput = document.getElementById('local-models-filter');
    filterInput?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.local-model-row').forEach(row => {
        const name = row.getAttribute('data-name') || '';
        const quant = row.getAttribute('data-quant') || '';
        row.style.display = (!q || name.includes(q) || quant.includes(q)) ? '' : 'none';
      });
    });

  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--perf-red); padding: 20px;">加载模型列表失败: ${window.escapeHtml(err.message)}</td></tr>`;
  }
}

window.copyModelPath = function (path) {
  navigator.clipboard.writeText(path).then(() => {
    window.toast(`已复制模型路径到剪贴板: ${path}`, 'success');
  }).catch(() => {
    window.toast(path, 'info');
  });
};

window.runLocalModelDirectly = async function (filePath, filename) {
  if (!confirm(`确定在 GPU 上启动并运行本地模型: ${filename} 吗？`)) return;
  window.toast(`正在启动 ${filename}...`, 'info');

  try {
    const res = await window.api.request('/api/llm/run-local', {
      method: 'POST',
      body: JSON.stringify({
        filePath,
        alias: filename.replace(/\.gguf$/i, ''),
        ngl: 999,
        ctx: 131072,
        ctk: 'q8_0',
        ctv: 'q8_0',
        port: 8080,
        fa: true
      })
    });
    window.toast(res.message, 'success');
    loadLLMStatus();
    document.querySelector('.llm-nav-tab[data-tab="chat"]')?.click();
  } catch (_) {}
};

window.openStartModalWithFile = function (filePath, filename, sizeBytes = 0) {
  const sourceSel = document.getElementById('start-model-source');
  const pathInput = document.getElementById('start-model-path');
  const aliasInput = document.getElementById('start-model-alias');

  if (sourceSel) sourceSel.value = 'file';
  if (pathInput) pathInput.value = filePath;
  if (aliasInput) aliasInput.value = filename.replace(/\.gguf$/i, '');
  setLaunchModelSize(sizeBytes || localModelMetadata.get(filePath)?.sizeBytes || 0);
  updateLlmMemoryEstimate();

  window.showModal('modal-start-llm');
};

window.deleteLocalModel = async function (filePath, filename) {
  if (!confirm(`⚠️ 危险操作：确定从服务器彻底删除模型文件 ${filename} 吗？`)) return;
  window.toast(`正在删除 ${filename}...`, 'info');

  try {
    const res = await window.api.request('/api/llm/local-models', {
      method: 'DELETE',
      body: JSON.stringify({ filePath })
    });
    window.toast(res.message, 'success');
    loadLocalModelsList();
  } catch (_) {}
};

// 4. Hugging Face Hub Online Explorer
let hfCurrentFilesList = [];

function setupHFExplorer() {
  const searchInput = document.getElementById('hf-search-query');
  const searchBtn = document.getElementById('btn-hf-search');
  const sortSelect = document.getElementById('hf-sort-select');
  const mirrorToggle = document.getElementById('hf-mirror-toggle');
  const directRepoInput = document.getElementById('hf-direct-repo-input');
  const directRepoBtn = document.getElementById('btn-hf-direct-jump');

  const savedMirror = localStorage.getItem('hf_mirror_enabled');
  if (savedMirror === 'true' && mirrorToggle) {
    mirrorToggle.checked = true;
    hfMirrorEnabled = true;
  }

  mirrorToggle?.addEventListener('change', (e) => {
    hfMirrorEnabled = e.target.checked;
    localStorage.setItem('hf_mirror_enabled', hfMirrorEnabled ? 'true' : 'false');
    window.toast(hfMirrorEnabled ? '已切换至国内加速镜像 (hf-mirror.com)' : '已切换至官方源 (huggingface.co)', 'info');
    triggerHFSearch();
  });

  sortSelect?.addEventListener('change', () => triggerHFSearch());
  searchBtn?.addEventListener('click', () => triggerHFSearch());

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerHFSearch();
  });

  directRepoBtn?.addEventListener('click', () => {
    const repo = directRepoInput?.value.trim();
    if (!repo) {
      window.toast('请输入 HuggingFace Repo ID，例如: Qwen/Qwen2.5-7B-Instruct-GGUF', 'error');
      return;
    }
    openHFModelFilesModal(repo);
  });
  directRepoInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') directRepoBtn?.click();
  });

  document.querySelectorAll('.hf-tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hf-tag-btn').forEach(b => b.classList.toggle('active', b === btn));
      const tag = btn.getAttribute('data-tag');
      if (searchInput) searchInput.value = tag;
      triggerHFSearch();
    });
  });

  document.getElementById('hf-modal-file-filter')?.addEventListener('input', (e) => {
    filterHFModalFiles(e.target.value);
  });

  document.querySelectorAll('.hf-modal-tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-tab');
      document.querySelectorAll('.hf-modal-tab-btn').forEach(t => t.classList.toggle('active', t === tab));
      const filesPane = document.getElementById('hf-modal-files-pane');
      const readmePane = document.getElementById('hf-modal-readme-pane');
      if (filesPane) filesPane.style.display = mode === 'files' ? 'block' : 'none';
      if (readmePane) readmePane.style.display = mode === 'readme' ? 'block' : 'none';

      if (mode === 'readme') loadHFModelReadme(hfCurrentRepo);
    });
  });

  document.getElementById('btn-refresh-local-models')?.addEventListener('click', loadLocalModelsList);
}

function triggerHFSearch() {
  const searchInput = document.getElementById('hf-search-query');
  const sortSelect = document.getElementById('hf-sort-select');
  const q = searchInput?.value.trim() || 'gguf';
  const sort = sortSelect?.value || 'downloads';
  searchHFModels(q, sort);
}
window.triggerHFSearch = triggerHFSearch;

async function searchHFModels(query, sort = 'downloads') {
  const container = document.getElementById('hf-models-grid');
  if (!container) return;
  container.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; color: var(--win-text-muted); padding: 50px 20px;">
      <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
      <div style="font-weight: 600; font-size: 13px;">正在连接 Hugging Face Hub 检索开源模型...</div>
      <div style="font-size: 11px; margin-top: 4px; color: var(--win-text-secondary);">${hfMirrorEnabled ? '通过国内加速镜像 hf-mirror.com' : '通过官方源 huggingface.co'}</div>
    </div>
  `;

  try {
    const mirrorParam = hfMirrorEnabled ? '&mirror=true' : '';
    const res = await window.api.request(`/api/llm/hf/search?q=${encodeURIComponent(query)}&sort=${sort}&limit=30${mirrorParam}`);
    const models = res.data;

    if (models.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; color: var(--win-text-muted); padding: 50px 20px;">
          <div style="font-size: 32px; margin-bottom: 8px;">📦</div>
          <div style="font-weight: 600;">未搜索到匹配的模型</div>
          <div style="font-size: 11px; margin-top: 4px;">建议尝试输入更通用的关键词（如 Qwen2.5, DeepSeek, Llama, GGUF）</div>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    for (const m of models) {
      const card = document.createElement('div');
      card.className = 'hf-model-card';
      card.addEventListener('click', () => openHFModelFilesModal(m.id));

      card.innerHTML = `
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 11px; color: var(--win-accent); font-weight: 600;">👤 ${window.escapeHtml(m.author)}</span>
            <div style="display: flex; gap: 4px;">
              ${m.paramScale ? `<span class="titlebar-host-badge" style="font-size: 9px; background: var(--win-accent); color: #fff;">${window.escapeHtml(m.paramScale)}</span>` : ''}
              <span class="titlebar-host-badge" style="font-size: 9px;">${m.isGguf ? 'GGUF' : 'HF Repo'}</span>
            </div>
          </div>
          <div class="hf-model-name" title="${window.escapeHtml(m.id)}">${window.escapeHtml(m.name)}</div>
          <div style="font-size: 10px; color: var(--win-text-secondary); font-family: var(--font-mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${window.escapeHtml(m.id)}</div>
        </div>

        <div style="margin-top: 12px; border-top: 1px dashed var(--win-border); padding-top: 8px;">
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--win-text-secondary);">
            <span>⬇️ ${(m.downloads || 0).toLocaleString()} 下载</span>
            <span>❤️ ${(m.likes || 0).toLocaleString()} 点赞</span>
          </div>

          <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 10px; color: var(--win-text-muted);">${m.lastModified ? window.escapeHtml(m.lastModified.slice(0, 10)) : ''}</span>
            <button class="cmd-btn primary btn-sm" style="font-size: 11px; padding: 2px 8px;">
              📦 浏览量化文件 &gt;
            </button>
          </div>
        </div>
      `;
      container.appendChild(card);
    }
  } catch (err) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--perf-red); padding: 40px;">
        <div style="font-size: 28px; margin-bottom: 6px;">⚠️</div>
        <div style="font-weight: 600;">检索失败: ${window.escapeHtml(err.message)}</div>
        <button class="cmd-btn btn-sm" style="margin-top: 10px;" data-action="hf-search">重试</button>
      </div>
    `;
  }
}

window.openHFModelFilesModal = async function (repoId) {
  hfCurrentRepo = repoId;
  const repoNameEl = document.getElementById('hf-modal-repo-name');
  if (repoNameEl) repoNameEl.innerText = repoId;
  const linkEl = document.getElementById('hf-modal-repo-link');
  if (linkEl) {
    const baseHost = hfMirrorEnabled ? 'https://hf-mirror.com' : 'https://huggingface.co';
    linkEl.href = `${baseHost}/${repoId}`;
    linkEl.innerText = `[在网页打开 ↗]`;
  }

  const filterInput = document.getElementById('hf-modal-file-filter');
  if (filterInput) filterInput.value = '';
  document.querySelector('.hf-modal-tab-btn[data-tab="files"]')?.click();

  const listContainer = document.getElementById('hf-model-files-list');
  if (listContainer) listContainer.innerHTML = '<div style="text-align: center; color: var(--win-text-muted); padding: 40px;">正在获取该仓库包含的所有 GGUF 量化文件及显存需求估算...</div>';
  window.showModal('modal-hf-files');

  try {
    const mirrorParam = hfMirrorEnabled ? '&mirror=true' : '';
    const res = await window.api.request(`/api/llm/hf/model-files?repo=${encodeURIComponent(repoId)}${mirrorParam}`);
    hfCurrentFilesList = res.data.files || [];
    renderHFModalFiles(hfCurrentFilesList);
  } catch (err) {
    if (listContainer) listContainer.innerHTML = `<div style="text-align: center; color: var(--perf-red); padding: 30px;">获取文件列表失败: ${window.escapeHtml(err.message)}</div>`;
  }
};

function renderHFModalFiles(files) {
  const listContainer = document.getElementById('hf-model-files-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  if (files.length === 0) {
    const emptyBox = document.createElement('div');
    emptyBox.style.textAlign = 'center';
    emptyBox.style.color = 'var(--win-text-secondary)';
    emptyBox.style.padding = '30px';

    const icon = document.createElement('div');
    icon.style.fontSize = '28px';
    icon.style.marginBottom = '6px';
    icon.textContent = '📂';
    emptyBox.appendChild(icon);

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = '未在仓库根目录下找到 .gguf 单文件';
    emptyBox.appendChild(title);

    const desc = document.createElement('div');
    desc.style.fontSize = '11px';
    desc.style.marginTop = '4px';
    desc.textContent = '该模型可能为分卷拆分或原生 SafeTensors 权重。您可以直接启动它:';
    emptyBox.appendChild(desc);

    const btnDirect = document.createElement('button');
    btnDirect.className = 'cmd-btn primary btn-sm';
    btnDirect.style.marginTop = '12px';
    btnDirect.textContent = '🚀 直接使用 llama-server 拉取并运行此 Repo';
    btnDirect.addEventListener('click', () => startHfDirectRepo(hfCurrentRepo));
    emptyBox.appendChild(btnDirect);

    listContainer.appendChild(emptyBox);
    return;
  }

  const table = document.createElement('table');
  table.className = 'win-table';
  table.style.marginTop = '4px';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>量化文件名称</th>
      <th>量化规格与推荐等级</th>
      <th>文件大小</th>
      <th>预估所需显存 (VRAM)</th>
      <th>操作</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const f of files) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameDiv = document.createElement('div');
    nameDiv.style.fontFamily = 'var(--font-mono)';
    nameDiv.style.fontSize = '12px';
    nameDiv.style.fontWeight = '600';
    nameDiv.style.color = 'var(--win-text-primary)';
    nameDiv.textContent = f.filename;
    tdName.appendChild(nameDiv);
    tr.appendChild(tdName);

    const tdQuant = document.createElement('td');
    const quantWrap = document.createElement('div');
    quantWrap.style.display = 'flex';
    quantWrap.style.alignItems = 'center';
    quantWrap.style.gap = '6px';
    const quantBadge = document.createElement('span');
    quantBadge.className = 'titlebar-host-badge';
    quantBadge.style.fontSize = '10px';
    quantBadge.textContent = f.quant;
    quantWrap.appendChild(quantBadge);
    const tagSpan = document.createElement('span');
    tagSpan.style.fontSize = '11px';
    tagSpan.style.fontWeight = '500';
    tagSpan.style.color = f.qualityColor;
    tagSpan.textContent = f.qualityTag;
    quantWrap.appendChild(tagSpan);
    tdQuant.appendChild(quantWrap);
    tr.appendChild(tdQuant);

    const tdSize = document.createElement('td');
    tdSize.style.fontFamily = 'var(--font-mono)';
    tdSize.style.fontWeight = '600';
    tdSize.textContent = f.sizeFormatted;
    tr.appendChild(tdSize);

    const tdVram = document.createElement('td');
    const vramSpan = document.createElement('span');
    vramSpan.style.fontFamily = 'var(--font-mono)';
    vramSpan.style.fontSize = '11px';
    vramSpan.style.color = 'var(--perf-green)';
    vramSpan.style.fontWeight = '600';
    vramSpan.textContent = `~${f.estimatedVram}`;
    tdVram.appendChild(vramSpan);
    tr.appendChild(tdVram);

    const tdActions = document.createElement('td');
    const actWrap = document.createElement('div');
    actWrap.style.display = 'flex';
    actWrap.style.gap = '6px';

    const btnDl = document.createElement('button');
    btnDl.className = 'cmd-btn primary btn-sm';
    btnDl.textContent = '⬇️ 下载到 /mnt/models';
    btnDl.addEventListener('click', () => startCloudDownload(hfCurrentRepo, f.filename, f.downloadUrl, f.sizeBytes));
    actWrap.appendChild(btnDl);

    const btnCopy = document.createElement('button');
    btnCopy.className = 'cmd-btn btn-sm';
    btnCopy.title = '复制直接下载链接';
    btnCopy.textContent = '🔗 链接';
    btnCopy.addEventListener('click', () => copyDirectUrl(f.downloadUrl));
    actWrap.appendChild(btnCopy);

    tdActions.appendChild(actWrap);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  listContainer.appendChild(table);
}

function filterHFModalFiles(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    renderHFModalFiles(hfCurrentFilesList);
    return;
  }
  const filtered = hfCurrentFilesList.filter(f => f.filename.toLowerCase().includes(q) || f.quant.toLowerCase().includes(q));
  renderHFModalFiles(filtered);
}

window.copyDirectUrl = function (url) {
  navigator.clipboard.writeText(url).then(() => {
    window.toast('下载链接已复制到剪贴板', 'success');
  });
};

async function loadHFModelReadme(repoId) {
  const container = document.getElementById('hf-modal-readme-pane');
  if (!container) return;
  container.innerHTML = '<div style="text-align: center; color: var(--win-text-muted); padding: 30px;">正在载入模型官方 README 说明...</div>';

  try {
    const mirrorParam = hfMirrorEnabled ? '&mirror=true' : '';
    const res = await window.api.request(`/api/llm/hf/readme?repo=${encodeURIComponent(repoId)}${mirrorParam}`);
    container.innerHTML = `
      <div class="hf-readme-container" style="background: var(--win-address-bg); border: 1px solid var(--win-border); border-radius: var(--radius-win); padding: 16px; font-size: 12px; line-height: 1.6; max-height: 480px; overflow-y: auto; color: var(--win-text-primary);">
        ${renderMarkdown(res.readme)}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: var(--perf-red); padding: 30px;">载入说明文档失败: ${window.escapeHtml(err.message)}</div>`;
  }
}

window.startHfDirectRepo = function (repoId) {
  window.closeModal('modal-hf-files');
  const pathInput = document.getElementById('start-model-path');
  const sourceSel = document.getElementById('start-model-source');
  const aliasInput = document.getElementById('start-model-alias');

  if (sourceSel) sourceSel.value = 'hf';
  if (pathInput) pathInput.value = repoId;
  if (aliasInput) aliasInput.value = repoId.split('/').pop();

  window.showModal('modal-start-llm');
};

// 5. Cloud Model Downloader
window.startCloudDownload = async function (repo, filename, downloadUrl, totalBytes) {
  window.toast(`已加入下载队列: ${filename}`, 'info');

  try {
    const res = await window.api.request('/api/llm/hf/download', {
      method: 'POST',
      body: JSON.stringify({
        repo,
        filename,
        downloadUrl,
        totalBytes,
        targetDir: '/mnt/models'
      })
    });
    window.toast(res.message, 'success');
    window.closeModal('modal-hf-files');

    document.querySelector('.llm-nav-tab[data-tab="tasks"]')?.click();
    loadDownloadTasks();
  } catch (_) {}
};

function setupDownloadManager() {
  document.getElementById('btn-refresh-download-tasks')?.addEventListener('click', loadDownloadTasks);
}

async function loadDownloadTasks(showToast = true) {
  const tbody = document.getElementById('download-tasks-table-body');
  if (!tbody) return;

  try {
    const res = await window.api.request('/api/llm/hf/tasks');
    const tasks = res.tasks || [];

    const badge = document.getElementById('tasks-badge-count');
    const activeTasks = tasks.filter(t => t.status === 'downloading');
    if (badge) {
      badge.innerText = activeTasks.length > 0 ? activeTasks.length : '';
      badge.style.display = activeTasks.length > 0 ? 'inline-block' : 'none';
    }

    if (tasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--win-text-muted); padding: 30px;">暂无下载任务，您可以在「Hugging Face 云端模型库」选择模型下载</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const t of tasks) {
      const isDl = t.status === 'downloading';
      const isDone = t.status === 'completed';

      const tr = document.createElement('tr');

      const tdFile = document.createElement('td');
      const fnameDiv = document.createElement('div');
      fnameDiv.style.fontWeight = '600';
      fnameDiv.style.fontFamily = 'var(--font-mono)';
      fnameDiv.style.color = 'var(--win-text-primary)';
      fnameDiv.textContent = t.filename;
      tdFile.appendChild(fnameDiv);

      const fdestDiv = document.createElement('div');
      fdestDiv.style.fontSize = '10px';
      fdestDiv.style.color = 'var(--win-text-secondary)';
      fdestDiv.textContent = t.destFile;
      tdFile.appendChild(fdestDiv);
      tr.appendChild(tdFile);

      const tdProg = document.createElement('td');
      tdProg.style.minWidth = '140px';
      const progHeader = document.createElement('div');
      progHeader.style.display = 'flex';
      progHeader.style.justifyContent = 'space-between';
      progHeader.style.fontSize = '11px';
      progHeader.style.marginBottom = '2px';
      progHeader.innerHTML = `<span>${window.escapeHtml(String(t.percent))}%</span><span>${window.escapeHtml(t.downloadedFormatted)} / ${window.escapeHtml(t.totalFormatted)}</span>`;
      tdProg.appendChild(progHeader);

      const progWrap = document.createElement('div');
      progWrap.className = 'win-progress';
      const progBar = document.createElement('div');
      progBar.className = `win-progress-bar ${isDone ? 'green' : 'blue'}`;
      progBar.style.width = `${t.percent}%`;
      progWrap.appendChild(progBar);
      tdProg.appendChild(progWrap);
      tr.appendChild(tdProg);

      const tdSpeed = document.createElement('td');
      tdSpeed.style.fontFamily = 'var(--font-mono)';
      tdSpeed.style.fontSize = '11px';
      tdSpeed.textContent = isDl ? t.speed : '--';
      tr.appendChild(tdSpeed);

      const tdEta = document.createElement('td');
      tdEta.style.fontSize = '11px';
      tdEta.style.color = 'var(--win-text-secondary)';
      tdEta.textContent = isDl ? t.eta : '--';
      tr.appendChild(tdEta);

      const tdStatus = document.createElement('td');
      const statusSpan = document.createElement('span');
      statusSpan.style.fontSize = '11px';
      statusSpan.style.fontWeight = '600';
      statusSpan.style.color = isDone ? 'var(--perf-green)' : isDl ? 'var(--perf-yellow)' : 'var(--perf-red)';
      statusSpan.textContent = isDone ? '✅ 已完成' : isDl ? '⬇️ 下载中' : '❌ 失败/中断';
      tdStatus.appendChild(statusSpan);
      tr.appendChild(tdStatus);

      const tdActions = document.createElement('td');
      const actGroup = document.createElement('div');
      actGroup.style.display = 'flex';
      actGroup.style.gap = '6px';

      if (isDone) {
        const btnRun = document.createElement('button');
        btnRun.className = 'cmd-btn primary btn-sm';
        btnRun.textContent = '🚀 立即运行';
        btnRun.addEventListener('click', () => runLocalModelDirectly(t.destFile, t.filename));
        actGroup.appendChild(btnRun);
      }

      if (isDl) {
        const btnCancel = document.createElement('button');
        btnCancel.className = 'cmd-btn danger btn-sm';
        btnCancel.textContent = '取消';
        btnCancel.addEventListener('click', () => cancelDownloadTask(t.id));
        actGroup.appendChild(btnCancel);
      }

      tdActions.appendChild(actGroup);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }

  } catch (err) {
    if (showToast) console.error('Failed to load tasks:', err);
  }
}

window.cancelDownloadTask = async function (taskId) {
  if (!confirm('确定取消并停止此模型的后台下载吗？')) return;
  try {
    const res = await window.api.request(`/api/llm/hf/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
    window.toast(res.message, 'info');
    loadDownloadTasks();
  } catch (_) {}
};

// 6. Interactive AI Chat Studio
function setupChatControls() {
  const sendBtn = document.getElementById('btn-chat-send');
  const stopBtn = document.getElementById('btn-chat-stop');
  const clearBtn = document.getElementById('btn-chat-clear');
  const input = document.getElementById('chat-user-input');

  const tempSlider = document.getElementById('slider-temperature');
  const tempVal = document.getElementById('val-temperature');
  tempSlider?.addEventListener('input', (e) => {
    if (tempVal) tempVal.innerText = e.target.value;
  });

  const toppSlider = document.getElementById('slider-topp');
  const toppVal = document.getElementById('val-topp');
  toppSlider?.addEventListener('input', (e) => {
    if (toppVal) toppVal.innerText = e.target.value;
  });

  const maxTokSlider = document.getElementById('slider-maxtokens');
  const maxTokVal = document.getElementById('val-maxtokens');
  maxTokSlider?.addEventListener('input', (e) => {
    if (maxTokVal) maxTokVal.innerText = e.target.value;
  });

  sendBtn?.addEventListener('click', handleSendMessage);
  clearBtn?.addEventListener('click', handleClearChat);
  stopBtn?.addEventListener('click', () => {
    if (abortController) {
      abortController.abort();
      isGenerating = false;
      toggleChatGenerating(false);
      window.toast('已中止生成', 'info');
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });
}

function handleClearChat() {
  if (isGenerating) return;
  chatHistory = [];
  const container = document.getElementById('chat-messages-container');
  if (container) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--win-text-muted); margin: auto; padding: 40px 20px;">
        <div style="font-size: 36px; margin-bottom: 8px;">🤖</div>
        <div style="font-size: 14px; font-weight: 600; color: var(--win-text-primary);">本地大模型推理交互控制台</div>
        <div style="font-size: 12px; margin-top: 4px;">由 ${window.escapeHtml(getLlmHost())} 上的本地推理服务驱动</div>
      </div>
    `;
  }
}

async function handleSendMessage() {
  if (isGenerating) return;
  const input = document.getElementById('chat-user-input');
  const prompt = input?.value?.trim();
  if (!prompt) return;

  input.value = '';

  const sysPrompt = document.getElementById('chat-system-prompt')?.value.trim() || '';
  const temperature = parseFloat(document.getElementById('slider-temperature')?.value || '0.7');
  const top_p = parseFloat(document.getElementById('slider-topp')?.value || '0.9');
  const max_tokens = parseInt(document.getElementById('slider-maxtokens')?.value || '4096', 10);
  const activeModel = currentLlmStatus?.modelName || 'gpt-oss-20b';

  const messages = [];
  if (sysPrompt) {
    messages.push({ role: 'system', content: sysPrompt });
  }
  for (const h of chatHistory) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: prompt });

  appendMessageBubble('user', prompt);
  chatHistory.push({ role: 'user', content: prompt });

  const assistantBubble = appendMessageBubble('assistant', '');
  const contentElement = assistantBubble.querySelector('.chat-bubble-content');
  const speedBadge = assistantBubble.querySelector('.chat-bubble-speed');

  isGenerating = true;
  toggleChatGenerating(true);
  abortController = new AbortController();

  let fullResponse = '';
  let thinkingResponse = '';
  let tokenCount = 0;
  const startTime = Date.now();
  let firstTokenTime = null;

  try {
    const response = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: activeModel,
        temperature,
        top_p,
        max_tokens,
        stream: true
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      const errJson = await response.json();
      throw new Error(errJson.error || '请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') break;

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta || {};
            const textChunk = delta.content || '';
            const reasoningChunk = delta.reasoning_content || '';

            if (textChunk || reasoningChunk) {
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                const ttftMs = firstTokenTime - startTime;
                const ttftEl = document.getElementById('chat-ttft');
                if (ttftEl) ttftEl.innerText = `${ttftMs} ms`;
              }
              tokenCount++;

              if (reasoningChunk) thinkingResponse += reasoningChunk;
              if (textChunk) fullResponse += textChunk;

              let renderedHtml = '';
              if (thinkingResponse) {
                renderedHtml += `
                  <details class="chat-thinking-box" open>
                    <summary>🧠 思考与推理过程</summary>
                    <div class="chat-thinking-content">${renderMarkdown(thinkingResponse)}</div>
                  </details>
                `;
              }
              if (fullResponse) {
                renderedHtml += `<div>${renderMarkdown(fullResponse)}</div>`;
              }

              contentElement.innerHTML = renderedHtml;

              const elapsedSec = (Date.now() - (firstTokenTime || startTime)) / 1000;
              if (elapsedSec > 0) {
                const tps = (tokenCount / elapsedSec).toFixed(1);
                if (speedBadge) speedBadge.innerText = `⚡ ${tps} tok/s | ${tokenCount} tok`;
                const tpsEl = document.getElementById('chat-token-speed');
                if (tpsEl) tpsEl.innerText = `${tps} t/s`;
              }
              const countEl = document.getElementById('chat-token-count');
              if (countEl) countEl.innerText = `${tokenCount} tokens`;

              scrollChatToBottom();
            }
          } catch (_) {}
        }
      }
    }

    chatHistory.push({ role: 'assistant', content: fullResponse || thinkingResponse });

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const avgTps = totalSec > 0 ? (tokenCount / totalSec).toFixed(1) : '--';
    if (speedBadge) {
      speedBadge.innerText = `⚡ 平均 ${avgTps} tok/s | 总耗时 ${totalSec}s | ${tokenCount} tokens`;
    }
    const tpsEl = document.getElementById('chat-token-speed');
    if (tpsEl) tpsEl.innerText = `${avgTps} t/s (平均)`;

  } catch (err) {
    if (err.name === 'AbortError') {
      contentElement.innerHTML += '<div style="color: var(--win-text-muted); font-size: 11px; margin-top: 4px;">[生成已被中止]</div>';
    } else {
      contentElement.innerHTML += `<div style="color: var(--perf-red); font-size: 12px; margin-top: 4px;">❌ 发生错误: ${window.escapeHtml(err.message)}</div>`;
    }
  } finally {
    isGenerating = false;
    toggleChatGenerating(false);
    abortController = null;
    scrollChatToBottom();
  }
}

window.sendBenchmarkPrompt = function (type) {
  const input = document.getElementById('chat-user-input');
  if (!input) return;

  const prompts = window.isEnglish?.() ? {
    code: 'Write a high-performance asynchronous web crawler in Python with concurrent connection pooling and resumable retries. Demonstrate a robust asyncio and aiohttp architecture.',
    reasoning: 'Two trains travel toward each other at 100 km/h and 80 km/h from 360 km apart. A falcon flies back and forth between them at 150 km/h until they meet. Derive the total flight distance and time, and explain the mathematics.',
    speed: 'Provide a detailed overview of open-source large language model development from 2024 to 2026. Compare dense and mixture-of-experts models, and discuss FlashAttention, MLA, KV-cache quantization, and AMD ROCm acceleration.'
  } : {
    code: '请用 Python 编写一个高性能、支持并发连接池与断点重试的异步网络爬虫，并详细演示 asyncio 与 aiohttp 的最佳架构实践。',
    reasoning: '一列火车以 100 km/h 速度向前行驶，另一列迎面驶来的火车以 80 km/h 行驶，两车相距 360 km。一只猎鹰以 150 km/h 的速度在两车车头之间来回折返飞行直到两车相遇。请详细推导并计算猎鹰飞行的总路程与总时间，并分析其物理数学原理。',
    speed: '请全面综述现代开源大型语言模型（LLM）在 2024~2026 年的技术演进路线，重点对比密集模型（Dense）与混合专家模型（MoE，如 DeepSeek-V3 / GPT-OSS），并从注意力机制优化（FlashAttention、MLA）、KV Cache 压缩量化以及在 AMD ROCm 生态下的算子加速策略展开深入论述。'
  };

  input.value = prompts[type] || prompts.code;
  input.focus();
  handleSendMessage();
};

function appendMessageBubble(role, content) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return null;

  const row = document.createElement('div');
  row.className = `chat-message-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.innerText = role === 'user' ? '👤' : '🤖';

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;

  const contentEl = document.createElement('div');
  contentEl.className = 'chat-bubble-content';
  contentEl.innerHTML = role === 'user' ? window.escapeHtml(content) : renderMarkdown(content);

  bubble.appendChild(contentEl);

  if (role === 'assistant') {
    const speedEl = document.createElement('div');
    speedEl.className = 'chat-bubble-speed';
    speedEl.innerText = '⚡ 准备生成...';
    bubble.appendChild(speedEl);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  container.appendChild(row);

  scrollChatToBottom();
  return row;
}

function toggleChatGenerating(active) {
  const sendBtn = document.getElementById('btn-chat-send');
  const stopBtn = document.getElementById('btn-chat-stop');
  const input = document.getElementById('chat-user-input');

  if (sendBtn) sendBtn.style.display = active ? 'none' : 'inline-flex';
  if (stopBtn) stopBtn.style.display = active ? 'inline-flex' : 'none';
  if (input) input.disabled = active;
}

function scrollChatToBottom() {
  const container = document.getElementById('chat-messages-container');
  if (container) container.scrollTop = container.scrollHeight;
}

// 7. Modals & Service Management
function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '--';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  if (minutes) return `${minutes}分 ${totalSeconds % 60}秒`;
  return `${totalSeconds}秒`;
}

function setLaunchModelSize(sizeBytes) {
  const estimateBox = document.getElementById('llm-memory-estimate');
  if (estimateBox) estimateBox.dataset.modelBytes = String(Number(sizeBytes) || 0);
}

function collectLaunchSettings() {
  const threadsValue = document.getElementById('start-model-threads')?.value.trim() || '';
  return {
    ngl: (() => {
      const value = Number.parseInt(document.getElementById('start-model-ngl')?.value, 10);
      return Number.isInteger(value) ? value : 999;
    })(),
    ctx: Number.parseInt(document.getElementById('start-model-ctx')?.value, 10) || 32768,
    ctk: document.getElementById('start-model-ctk')?.value || 'q8_0',
    ctv: document.getElementById('start-model-ctv')?.value || 'q8_0',
    threads: threadsValue ? Number.parseInt(threadsValue, 10) : null,
    parallel: Number.parseInt(document.getElementById('start-model-parallel')?.value, 10) || 1,
    port: Number.parseInt(document.getElementById('start-model-port')?.value, 10) || 8080,
    fa: Boolean(document.getElementById('start-model-fa')?.checked)
  };
}

function applyLaunchSettings(settings) {
  const values = settings || LLM_LAUNCH_PRESETS.balanced;
  const assignments = {
    'start-model-ngl': values.ngl,
    'start-model-ctx': values.ctx,
    'start-model-ctk': values.ctk,
    'start-model-ctv': values.ctv,
    'start-model-threads': values.threads ?? '',
    'start-model-parallel': values.parallel ?? 1,
    'start-model-port': values.port ?? 8080
  };
  for (const [id, value] of Object.entries(assignments)) {
    const element = document.getElementById(id);
    if (element) element.value = String(value);
  }
  const flashAttention = document.getElementById('start-model-fa');
  if (flashAttention) flashAttention.checked = values.fa !== false;
  updateLlmMemoryEstimate();
}

function updateLlmMemoryEstimate() {
  const estimateBox = document.getElementById('llm-memory-estimate');
  const valueBox = document.getElementById('llm-memory-estimate-value');
  if (!estimateBox || !valueBox) return;

  const settings = collectLaunchSettings();
  const modelBytes = Number(estimateBox.dataset.modelBytes || 0);
  const modelGb = modelBytes / (1024 ** 3);
  const cacheBytesPerToken = {
    f32: 262144, f16: 131072, bf16: 131072, q8_0: 65536,
    q4_0: 32768, q4_1: 36864, q5_0: 40960, q5_1: 45056, iq4_nl: 32768
  };
  const avgCacheBytes = (
    (cacheBytesPerToken[settings.ctk] || 65536) +
    (cacheBytesPerToken[settings.ctv] || 65536)
  ) / 2;
  const kvGb = settings.ctx * avgCacheBytes / (1024 ** 3);
  const runtimeGb = 0.8 + Math.max(0, settings.parallel - 1) * 0.35;
  const estimateGb = modelGb > 0 ? modelGb * 1.08 + kvGb + runtimeGb : kvGb + runtimeGb;

  valueBox.innerText = modelGb > 0
    ? `约 ${estimateGb.toFixed(1)} GB（模型 ${modelGb.toFixed(1)} GB + KV/缓冲约 ${(kvGb + runtimeGb).toFixed(1)} GB）`
    : `模型大小未知；KV Cache 与运行缓冲约 ${estimateGb.toFixed(1)} GB`;
}

function setupLLMLaunchEnhancements() {
  const presetSelect = document.getElementById('start-model-preset');
  const saved = localStorage.getItem(LLM_LAUNCH_SETTINGS_KEY);
  if (saved) {
    try {
      applyLaunchSettings(JSON.parse(saved));
      if (presetSelect) presetSelect.value = 'custom';
    } catch (_) {
      applyLaunchSettings(LLM_LAUNCH_PRESETS.balanced);
    }
  } else {
    applyLaunchSettings(LLM_LAUNCH_PRESETS.balanced);
  }

  presetSelect?.addEventListener('change', (event) => {
    if (event.target.value === 'custom') {
      const customSaved = localStorage.getItem(LLM_LAUNCH_SETTINGS_KEY);
      if (customSaved) {
        try { applyLaunchSettings(JSON.parse(customSaved)); } catch (_) {}
      }
      return;
    }
    applyLaunchSettings(LLM_LAUNCH_PRESETS[event.target.value]);
  });

  const watchedIds = [
    'start-model-ngl', 'start-model-ctx', 'start-model-ctk', 'start-model-ctv',
    'start-model-threads', 'start-model-parallel', 'start-model-port', 'start-model-fa'
  ];
  for (const id of watchedIds) {
    document.getElementById(id)?.addEventListener('input', () => {
      if (presetSelect) presetSelect.value = 'custom';
      updateLlmMemoryEstimate();
    });
  }

  document.getElementById('start-model-path')?.addEventListener('input', (event) => {
    setLaunchModelSize(localModelMetadata.get(event.target.value.trim())?.sizeBytes || 0);
    updateLlmMemoryEstimate();
  });
}

function setupLLMModals() {
  setupLLMLaunchEnhancements();
  document.getElementById('btn-llm-start-modal')?.addEventListener('click', () => {
    const path = document.getElementById('start-model-path')?.value.trim();
    setLaunchModelSize(localModelMetadata.get(path)?.sizeBytes || 0);
    updateLlmMemoryEstimate();
    window.showModal('modal-start-llm');
  });

  document.getElementById('btn-confirm-start-llm')?.addEventListener('click', async () => {
    const source = document.getElementById('start-model-source')?.value;
    const modelPath = document.getElementById('start-model-path')?.value.trim();
    const alias = document.getElementById('start-model-alias')?.value.trim();
    const nglInput = parseInt(document.getElementById('start-model-ngl')?.value, 10);
    const ngl = Number.isInteger(nglInput) ? nglInput : 999;
    const ctx = parseInt(document.getElementById('start-model-ctx')?.value, 10) || 131072;
    const ctk = document.getElementById('start-model-ctk')?.value;
    const ctv = document.getElementById('start-model-ctv')?.value;
    const port = parseInt(document.getElementById('start-model-port')?.value, 10) || 8080;
    const threadsRaw = document.getElementById('start-model-threads')?.value.trim();
    const parallel = parseInt(document.getElementById('start-model-parallel')?.value, 10) || 1;
    const threads = threadsRaw ? parseInt(threadsRaw, 10) : null;
    const fa = document.getElementById('start-model-fa')?.checked;

    if (!modelPath) {
      window.toast('请输入模型路径或 Repo ID', 'error');
      return;
    }

    window.toast('正在向服务器下发模型启动指令...', 'info');
    try {
      const res = await window.api.request('/api/llm/start', {
        method: 'POST',
        body: JSON.stringify({ source, modelPath, ngl, ctx, ctk, ctv, port, alias, threads, parallel, fa })
      });
      localStorage.setItem(LLM_LAUNCH_SETTINGS_KEY, JSON.stringify({
        ngl, ctx, ctk, ctv, port, threads, parallel, fa
      }));
      const presetSelect = document.getElementById('start-model-preset');
      if (presetSelect) presetSelect.value = 'custom';
      window.toast(res.message, 'success');
      window.closeModal('modal-start-llm');
      setTimeout(loadLLMStatus, 2000);
    } catch (_) {}
  });

  document.getElementById('btn-llm-restart')?.addEventListener('click', async () => {
    window.toast('正在重启推理模型...', 'info');
    try {
      const res = await window.api.request('/api/llm/restart', { method: 'POST' });
      window.toast(res.message, 'success');
      setTimeout(loadLLMStatus, 2000);
    } catch (_) {}
  });

  document.getElementById('btn-llm-stop')?.addEventListener('click', async () => {
    if (!confirm('确定停止当前的 llama-server 推理服务吗？')) return;
    try {
      const res = await window.api.request('/api/llm/stop', { method: 'POST' });
      window.toast(res.message, 'success');
      loadLLMStatus();
    } catch (_) {}
  });

  document.getElementById('btn-llm-logs')?.addEventListener('click', loadLLMLogs);
  document.getElementById('btn-refresh-llm-logs')?.addEventListener('click', loadLLMLogs);
}

async function loadLLMLogs() {
  const box = document.getElementById('llm-logs-content');
  if (!box) return;
  box.innerText = '正在读取日志...';
  window.showModal('modal-llm-logs');

  try {
    const res = await window.api.request('/api/llm/logs');
    box.innerText = res.logs || '暂无运行日志';
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    box.innerText = `加载日志失败: ${err.message}`;
  }
}

// 8. Markdown & Utils
window.copyCodeBlock = function (id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    window.toast('代码已复制到剪贴板', 'success');
  });
};
