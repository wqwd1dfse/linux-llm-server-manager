// Windows 11 App Navigation, Theme Toggle, Auth, and Lazy Loading

window.currentView = 'files';
window.serverConnectionConfig = null;
const initializedViews = new Set();
let serverProfiles = [];

document.addEventListener('DOMContentLoaded', async () => {
  const fragmentsReady = await (window.uiFragmentsReady || Promise.resolve(true));
  if (!fragmentsReady) return;
  initTheme();
  setupTreeNavigation();
  setupCommandBar();
  setupSettingsForm();
  setupAuthUI();
  setupGlobalActions();
  setupAccessibility();

  if (window.initI18n) window.initI18n();

  // Check Auth & Initial Load
  checkAuthAndInitialize();

  // Search input filter
  document.getElementById('global-search-input')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const activePanel = document.querySelector('.view-panel.active');
    if (!activePanel) return;

    const rows = activePanel.querySelectorAll('tbody tr');
    rows.forEach((row) => {
      const text = row.innerText.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  });
});


window.addEventListener('languagechange', () => {
  applyTheme(localStorage.getItem('win-theme') || 'dark');

  if (window.currentView === 'files' && typeof window.currentPath !== 'undefined') {
    renderAddressBarFiles(window.currentPath);
  } else {
    updateAddressBarForView(window.currentView);
  }

  renderServerProfiles(window.serverConnectionConfig?.activeProfileId || null);
});
// Lazy View Initializer
function lazyInitView(view) {
  const initKey = view.startsWith('monitor-') ? 'dashboard' : view;
  if (initializedViews.has(initKey)) return;

  switch (view) {
    case 'files':
      if (window.initFiles) { window.initFiles(); initializedViews.add('files'); }
      break;
    case 'monitor-cpu':
    case 'monitor-gpu':
    case 'monitor-ram':
    case 'monitor-ssd':
      if (window.initDashboard) { window.initDashboard(); initializedViews.add('dashboard'); }
      break;
    case 'terminal':
      if (window.initTerminal) { window.initTerminal(); initializedViews.add('terminal'); }
      break;
    case 'docker':
      if (window.initDocker) { window.initDocker(); initializedViews.add('docker'); }
      break;
    case 'services':
      if (window.initServices) { window.initServices(); initializedViews.add('services'); }
      break;
    case 'scripts':
      if (window.initScripts) { window.initScripts(); initializedViews.add('scripts'); }
      break;
    case 'llm':
      if (window.initLLM) { window.initLLM(); initializedViews.add('llm'); }
      break;
    case 'fan':
      if (window.initFan) { window.initFan(); initializedViews.add('fan'); }
      break;
    case 'settings':
      if (window.initSettings) { window.initSettings(); initializedViews.add('settings'); }
      break;
  }
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('win-theme') || 'dark';
  applyTheme(savedTheme);

  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const curr = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = curr === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('win-theme', theme);

  const isEn = window.getLanguage ? window.getLanguage() === 'en-US' : true;
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');

  if (icon && label) {
    if (theme === 'dark') {
      icon.innerText = '☀️';
      label.innerText = isEn ? 'Light Mode' : '浅色模式';
    } else {
      icon.innerText = '🌙';
      label.innerText = isEn ? 'Dark Mode' : '深色模式';
    }
  }
}

// Navigation & Command Bar
function setupTreeNavigation() {
  const treeNodes = document.querySelectorAll('.nav-node');

  treeNodes.forEach((node, index) => {
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-current', node.classList.contains('active') ? 'page' : 'false');

    const activate = () => {
      const view = node.getAttribute('data-view');
      if (view) switchView(view);
    };

    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (index + offset + treeNodes.length) % treeNodes.length;
        treeNodes[nextIndex]?.focus();
      }
    });
  });
}

function switchView(view) {
  window.currentView = view;
  const treeNodes = document.querySelectorAll('.nav-node');
  const viewPanels = document.querySelectorAll('.view-panel');

  treeNodes.forEach((node) => {
    const isActive = node.getAttribute('data-view') === view;
    node.classList.toggle('active', isActive);
    node.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
  viewPanels.forEach((panel) => {
    const isActive = panel.id === `view-${view}`;
    panel.classList.toggle('active', isActive);
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  const isFiles = view === 'files';
  const fileBtns = ['cmd-btn-new-folder', 'cmd-btn-new-file', 'cmd-btn-upload'];
  fileBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isFiles ? 'inline-flex' : 'none';
  });

  const navHistoryGroup = document.querySelector('.nav-history-group');
  if (navHistoryGroup) navHistoryGroup.style.display = isFiles ? 'flex' : 'none';

  // Lazy initialize this view
  lazyInitView(view);

  if (isFiles && window.navigateToDir && typeof window.currentPath !== 'undefined') {
    renderAddressBarFiles(window.currentPath);
  } else {
    updateAddressBarForView(view);
  }

  if (view === 'terminal' && window.resizeTerminal) {
    window.resizeTerminal();
  }

  if (view === 'fan') {
    if (window.loadFanStatus) window.loadFanStatus();
    if (window.loadFanHistory) window.loadFanHistory(window.currentFanHistoryRange || '5m');
  }
}
window.switchView = switchView;

function renderAddressBarFiles(p) {
  const box = document.getElementById('address-bar-box');
  if (!box) return;

  box.innerHTML = '';
  const rootCrumb = document.createElement('span');
  rootCrumb.className = 'address-crumb-item';
  rootCrumb.textContent = `🖥️ ${getServerTargetLabel(false)}`;
  rootCrumb.addEventListener('click', () => window.navigateToDir?.('/'));
  box.appendChild(rootCrumb);

  const parts = (p || '/').split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated += `/${part}`;
    const currPath = accumulated;

    const sep = document.createElement('span');
    sep.textContent = ' > ';
    sep.style.margin = '0 2px';
    box.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'address-crumb-item';
    crumb.textContent = part;
    crumb.addEventListener('click', () => window.navigateToDir?.(currPath));
    box.appendChild(crumb);
  }
}
window.renderAddressBarFiles = renderAddressBarFiles;

function updateAddressBarForView(view) {
  const box = document.getElementById('address-bar-box');
  if (!box) return;

  const isEn = window.getLanguage ? window.getLanguage() === 'en-US' : true;
  const viewTitles = isEn ? {
    'files': 'Remote Filesystem (SFTP)',
    'terminal': 'Web Terminal (SSH)',
    'llm': 'LLM Studio & Inference',
    'fan': 'Fan & Cooling Console',
    'docker': 'Docker Containers & Images',
    'services': 'Processes & Systemd Services',
    'scripts': 'DevOps Toolbox & Scripts',
    'monitor-cpu': 'Hardware Telemetry > CPU Processor Monitor',
    'monitor-gpu': 'Hardware Telemetry > GPU Multi-Card Monitor',
    'monitor-ram': 'Hardware Telemetry > Memory (RAM) Monitor',
    'monitor-ssd': 'Hardware Telemetry > Disk / SSD Storage',
    'settings': 'System & Preferences'
  } : {
    'files': '远程文件系统 (SFTP)',
    'terminal': 'Web 命令行终端 (SSH)',
    'llm': '大模型控制台 (LLM Studio)',
    'fan': '风扇与散热控制台 (Fan Control)',
    'docker': 'Docker 容器与镜像',
    'services': '进程与 Systemd 服务',
    'scripts': '常用运维工具箱',
    'monitor-cpu': '性能与硬件监控 > CPU 处理器详细监控',
    'monitor-gpu': '性能与硬件监控 > GPU 显卡多卡详细监控',
    'monitor-ram': '性能与硬件监控 > 内存 (RAM) 详细监控',
    'monitor-ssd': '性能与硬件监控 > 磁盘 / SSD 存储详细监控',
    'settings': '配置管理 > 系统与偏好设置'
  };

  const title = viewTitles[view] || view;
  const target = getServerTargetLabel(false);
  const serverText = isEn ? `This Server · ${target}` : `此服务器 · ${target}`;
  box.innerHTML = `<span>🖥️ ${serverText}</span> <span>&gt;</span> <span class="address-crumb-item">${window.escapeHtml(title)}</span>`;
}

function setupCommandBar() {
  document.getElementById('cmd-btn-terminal')?.addEventListener('click', () => switchView('terminal'));
  document.getElementById('cmd-btn-settings')?.addEventListener('click', () => switchView('settings'));
  document.getElementById('btn-quick-login')?.addEventListener('click', () => switchView('settings'));

  document.getElementById('cmd-btn-refresh')?.addEventListener('click', () => {
    window.location.reload();
  });
}

function invokeWindowAction(name, ...args) {
  const action = window[name];
  if (typeof action === 'function') {
    return action(...args);
  }
  console.warn(`[UI] Action is not available: ${name}`);
  return undefined;
}

function setupGlobalActions() {
  const actionHandlers = {
    'paste-clipboard': () => invokeWindowAction('pasteClipboard'),
    'copy-selection': (el) => invokeWindowAction('copySelection', el.dataset.cut === 'true'),
    'batch-compress': () => invokeWindowAction('batchCompress'),
    'batch-delete': () => invokeWindowAction('batchDelete'),
    'send-benchmark': (el) => invokeWindowAction('sendBenchmarkPrompt', el.dataset.benchmark),
    'show-modal': (el) => window.showModal?.(el.dataset.modal),
    'control-fan-service': (el) => invokeWindowAction('controlFanService', el.dataset.serviceAction),
    'load-fan-logs': () => invokeWindowAction('loadFanLogs'),
    'export-fan-chart': () => invokeWindowAction('exportFanChartPNG'),
    'toggle-fan-series': (el) => {
      invokeWindowAction('toggleFanSeries', el.dataset.series);
      el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
    },
    'set-fan-mode': (el) => invokeWindowAction('setPresetMode', el.dataset.mode),
    'apply-single-fan': (el) => invokeWindowAction('applySingleFan', el.dataset.channel, el.dataset.slider),
    'apply-all-fans': () => invokeWindowAction('applyAllFans'),
    'open-file-editor': () => invokeWindowAction('openFileEditor'),
    'download-file': () => invokeWindowAction('downloadFile'),
    'extract-archive': () => invokeWindowAction('extractArchive'),
    'show-chmod': () => invokeWindowAction('showChmodModal'),
    'show-properties': () => invokeWindowAction('showPropertiesModal'),
    'rename-item': () => invokeWindowAction('renameItem'),
    'delete-item': () => invokeWindowAction('deleteItem'),
    'hf-search': () => invokeWindowAction('triggerHFSearch'),
    'copy-code-block': (el) => invokeWindowAction('copyCodeBlock', el.dataset.codeId)
  };

  document.addEventListener('click', (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;
    const handler = actionHandlers[actionElement.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(actionElement);
    actionElement.closest('.win-context-menu')?.classList.remove('show');
  });

  document.getElementById('select-all-checkbox')?.addEventListener('change', (event) => {
    invokeWindowAction('toggleSelectAll', event.target.checked);
  });

  document.addEventListener('keydown', (event) => {
    const keyboardAction = event.target.closest('[data-action][role="menuitem"], .quick-path-chip');
    if (keyboardAction && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      keyboardAction.click();
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      document.getElementById('global-search-input')?.focus();
    }
  });
}

function setupAccessibility() {
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-hidden', String(!panel.classList.contains('active')));
  });

  document.querySelectorAll('.quick-path-chip').forEach((chip) => {
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
  });

  document.querySelectorAll('.win-form-group label:not([for]), .form-group label:not([for])').forEach((label) => {
    const group = label.closest('.win-form-group, .form-group');
    const control = group?.querySelector('input[id], select[id], textarea[id]');
    if (control?.id) label.htmlFor = control.id;
  });

  document.querySelectorAll('button').forEach((button) => {
    if (!button.getAttribute('aria-label') && button.title) {
      button.setAttribute('aria-label', button.title);
    } else if (!button.getAttribute('aria-label') && button.textContent.trim() === '×') {
      button.setAttribute('aria-label', '关闭弹窗');
    }
  });
}

function getServerTargetLabel(includeUser = true) {
  const config = window.serverConnectionConfig;
  if (!config?.host) return window.localize ? window.localize('目标服务器', 'Target server') : 'Target server';
  const host = `${config.host}:${config.port || 22}`;
  return includeUser && config.username ? `${config.username}@${host}` : host;
}
function fillServerProfileForm(profile = null) {
  const values = profile || {};
  const assignments = {
    'setting-profile-id': values.id || '',
    'setting-profile-name': values.name || '',
    'setting-host': values.host || '',
    'setting-port': values.port || 22,
    'setting-username': values.username || 'root',
    'setting-auth-type': values.authType || 'password',
    'setting-password': '',
    'setting-key': '',
    'setting-passphrase': ''
  };
  for (const [id, value] of Object.entries(assignments)) {
    const element = document.getElementById(id);
    if (element) element.value = String(value);
  }
  const remember = document.getElementById('setting-remember');
  if (remember) remember.checked = Boolean(profile);

  const isKey = values.authType === 'key';
  const passwordGroup = document.getElementById('group-password');
  const keyGroup = document.getElementById('group-key');
  if (passwordGroup) passwordGroup.style.display = isKey ? 'none' : 'flex';
  if (keyGroup) keyGroup.style.display = isKey ? 'flex' : 'none';
}

function renderServerProfiles(activeProfileId = null) {
  const list = document.getElementById('server-profiles-list');
  const quickSwitch = document.getElementById('server-quick-switch');

  if (quickSwitch) {
    quickSwitch.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = serverProfiles.length
      ? (window.localize ? window.localize('快速切换服务器...', 'Quickly switch servers...') : 'Quickly switch servers...')
      : (window.localize ? window.localize('暂无已保存服务器', 'No saved servers') : 'No saved servers');
    quickSwitch.appendChild(placeholder);
  }

  if (list) list.replaceChildren();
  if (serverProfiles.length === 0) {
    if (list) {
      const empty = document.createElement('div');
      empty.className = 'server-profile-empty';
      empty.textContent = window.localize
        ? window.localize('还没有保存服务器档案。填写下方连接信息并勾选保存凭据即可创建。', 'No server profiles are saved yet. Complete the connection form and enable credential storage to create one.')
        : 'No server profiles are saved yet. Complete the connection form and enable credential storage to create one.';
      list.appendChild(empty);
    }
    return;
  }

  for (const profile of serverProfiles) {
    if (quickSwitch) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `${profile.name} · ${profile.username}@${profile.host}`;
      option.selected = profile.id === activeProfileId;
      quickSwitch.appendChild(option);
    }

    if (!list) continue;
    const card = document.createElement('div');
    card.className = `server-profile-card${profile.id === activeProfileId ? ' active' : ''}`;

    const info = document.createElement('div');
    info.className = 'server-profile-info';
    const title = document.createElement('strong');
    title.textContent = profile.name;
    const target = document.createElement('span');
    const authLabel = profile.authType === 'key'
      ? (window.localize ? window.localize('私钥', 'Private key') : 'Private key')
      : (window.localize ? window.localize('密码', 'Password') : 'Password');
    target.textContent = `${profile.username}@${profile.host}:${profile.port} · ${authLabel}`;
    info.append(title, target);

    const actions = document.createElement('div');
    actions.className = 'server-profile-actions';

    if (profile.id === activeProfileId) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'server-profile-active-badge';
      activeBadge.textContent = '● 当前';
      actions.appendChild(activeBadge);
    } else {
      const connectButton = document.createElement('button');
      connectButton.className = 'cmd-btn btn-sm primary';
      connectButton.textContent = '切换';
      connectButton.addEventListener('click', () => connectServerProfile(profile.id));
      actions.appendChild(connectButton);
    }

    const editButton = document.createElement('button');
    editButton.className = 'cmd-btn btn-sm';
    editButton.textContent = '编辑';
    editButton.addEventListener('click', () => {
      fillServerProfileForm(profile);
      document.getElementById('setting-profile-name')?.focus();
    });
    actions.appendChild(editButton);

    if (profile.id !== activeProfileId) {
      const deleteButton = document.createElement('button');
      deleteButton.className = 'cmd-btn btn-sm danger';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', () => deleteServerProfile(profile));
      actions.appendChild(deleteButton);
    }

    card.append(info, actions);
    list.appendChild(card);
  }
}

async function loadServerProfiles(activeProfileId = window.serverConnectionConfig?.activeProfileId || null) {
  try {
    const res = await window.api.request('/api/auth/profiles');
    serverProfiles = res.profiles || [];
    renderServerProfiles(res.activeProfileId || activeProfileId);
  } catch (_) {}
}

async function refreshViewsAfterServerSwitch() {
  if (window.refreshFileServerContext) window.refreshFileServerContext();
  if (window.loadFanStatus) window.loadFanStatus();
  if (window.loadLLMStatus) window.loadLLMStatus();
  if (window.loadDockerContainers) window.loadDockerContainers();
  if (window.loadProcesses) window.loadProcesses();
}

async function connectServerProfile(profileId) {
  if (!profileId || profileId === window.serverConnectionConfig?.activeProfileId) return;
  const profile = serverProfiles.find(item => item.id === profileId);
  if (!profile) return;

  window.toast(`正在切换到 ${profile.name}...`, 'info');
  const selector = document.getElementById('server-quick-switch');
  if (selector) selector.disabled = true;
  try {
    const res = await window.api.request(`/api/auth/profiles/${encodeURIComponent(profileId)}/connect`, { method: 'POST' });
    window.toast(res.message, 'success');
    await checkAuthStatus();
    await refreshViewsAfterServerSwitch();
  } catch (_) {
    if (selector) selector.value = window.serverConnectionConfig?.activeProfileId || '';
  } finally {
    if (selector) selector.disabled = false;
  }
}

async function deleteServerProfile(profile) {
  if (!confirm(`确定删除服务器档案“${profile.name}”吗？远程服务器上的数据不会受影响。`)) return;
  try {
    const res = await window.api.request(`/api/auth/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    window.toast(res.message, 'success');
    if (document.getElementById('setting-profile-id')?.value === profile.id) fillServerProfileForm();
    loadServerProfiles();
  } catch (_) {}
}

function setupSettingsForm() {
  const authTypeSelect = document.getElementById('setting-auth-type');
  const groupPassword = document.getElementById('group-password');
  const groupKey = document.getElementById('group-key');
  const form = document.getElementById('settings-form');

  document.getElementById('server-quick-switch')?.addEventListener('change', (event) => {
    if (event.target.value) connectServerProfile(event.target.value);
  });
  document.getElementById('btn-new-server-profile')?.addEventListener('click', () => {
    fillServerProfileForm();
    const remember = document.getElementById('setting-remember');
    if (remember) remember.checked = true;
    document.getElementById('setting-profile-name')?.focus();
  });

  authTypeSelect?.addEventListener('change', (e) => {
    const isKey = e.target.value === 'key';
    if (groupPassword) groupPassword.style.display = isKey ? 'none' : 'flex';
    if (groupKey) groupKey.style.display = isKey ? 'flex' : 'none';
  });

  // Test Connection
  document.getElementById('btn-test-connection')?.addEventListener('click', async () => {
    const host = document.getElementById('setting-host').value;
    const port = document.getElementById('setting-port').value;
    const username = document.getElementById('setting-username').value;
    const authType = authTypeSelect?.value || 'password';
    const password = document.getElementById('setting-password').value;
    const privateKey = document.getElementById('setting-key').value;
    const passphrase = document.getElementById('setting-passphrase').value;
    const profileId = document.getElementById('setting-profile-id')?.value || '';

    window.toast('正在测试 SSH 连接...', 'info');

    try {
      const res = await window.api.request('/api/auth/test', {
        method: 'POST',
        body: JSON.stringify({ host, port, username, authType, password, privateKey, passphrase, profileId })
      });

      if (res.success) {
        window.toast(`连接测试成功! ${res.system || ''}`, 'success');
      } else {
        window.toast(`测试失败: ${res.error}`, 'error');
      }
    } catch (_) {}
  });

  // Save & Connect Submit
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = document.getElementById('setting-host').value;
    const port = document.getElementById('setting-port').value;
    const username = document.getElementById('setting-username').value;
    const authType = authTypeSelect?.value || 'password';
    const password = document.getElementById('setting-password').value;
    const privateKey = document.getElementById('setting-key').value;
    const passphrase = document.getElementById('setting-passphrase').value;
    const remember = document.getElementById('setting-remember')?.checked === true;
    const profileId = document.getElementById('setting-profile-id')?.value || '';
    const profileName = document.getElementById('setting-profile-name')?.value.trim() || '';

    const btn = document.getElementById('btn-save-connect');
    if (btn) {
      btn.disabled = true;
      btn.innerText = '正在验证连接...';
    }

    try {
      await window.api.request('/api/auth/connect', {
        method: 'POST',
        body: JSON.stringify({ host, port, username, authType, password, privateKey, passphrase, remember, profileId, profileName })
      });

      window.toast(remember ? '已连接目标主机并保存服务器档案' : '已连接目标主机，凭据仅用于本次运行', 'success');
      await checkAuthStatus();
      await loadServerProfiles();
      if (window.navigateToDir) window.navigateToDir(window.currentPath || '/root');
      if (window.loadFanStatus) window.loadFanStatus();
      if (window.loadLLMStatus) window.loadLLMStatus();
      if (window.loadDockerContainers) window.loadDockerContainers();
      if (window.loadProcesses) window.loadProcesses();
      switchView(window.currentView || 'monitor-cpu');
    } catch (_) {
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerText = '建立 SSH 会话';
      }
    }
  });
}

// -----------------------------------------------------------
// Authentication & Setup UI
// -----------------------------------------------------------
function setupAuthUI() {
  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username')?.value.trim();
    const password = document.getElementById('login-password')?.value;
    const errEl = document.getElementById('login-error-msg');
    if (errEl) errEl.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.needsSetup) {
          showSetupModal();
          return;
        }
        if (errEl) {
          errEl.innerText = data.error || '登录失败';
          errEl.style.display = 'block';
        }
        return;
      }

      window.closeModal('modal-login');
      window.toast('登录成功', 'success');
      checkAuthAndInitialize();
    } catch (err) {
      if (errEl) {
        errEl.innerText = err.message;
        errEl.style.display = 'block';
      }
    }
  });

  // Setup Form
  const setupForm = document.getElementById('setup-form');
  setupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('setup-password')?.value;
    const confirm = document.getElementById('setup-password-confirm')?.value;
    const errEl = document.getElementById('setup-error-msg');
    if (errEl) errEl.style.display = 'none';

    if (password !== confirm) {
      if (errEl) {
        errEl.innerText = '两次输入的密码不一致';
        errEl.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        if (errEl) {
          errEl.innerText = data.error || '设置失败';
          errEl.style.display = 'block';
        }
        return;
      }

      window.closeModal('modal-setup');
      window.toast('管理员密码设置成功！', 'success');
      checkAuthAndInitialize();
    } catch (err) {
      if (errEl) {
        errEl.innerText = err.message;
        errEl.style.display = 'block';
      }
    }
  });

  // Logout Button
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try {
      await window.api.request('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    window.location.reload();
  });
}

window.showLoginModal = function (msg = '') {
  const errEl = document.getElementById('login-error-msg');
  if (errEl) {
    errEl.innerText = msg;
    errEl.style.display = msg ? 'block' : 'none';
  }
  window.showModal('modal-login');
};

function showSetupModal() {
  window.closeModal('modal-login');
  window.showModal('modal-setup');
}

async function checkAuthAndInitialize() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();

    if (data.needsSetup) {
      showSetupModal();
      return;
    }

    if (!data.authenticated) {
      window.showLoginModal();
      return;
    }

    // Authenticated: initialize default view
    await checkAuthStatus();
    lazyInitView(window.currentView || 'files');
  } catch (err) {
    window.showLoginModal();
  }
}

async function checkAuthStatus() {
  try {
    const res = await window.api.request('/api/auth/status');
    const { connected, config } = res;

    window.updateConnectionStatus(connected);

    if (config) {
      window.serverConnectionConfig = config;
      document.title = `${config.host} · ${window.localize ? window.localize('Linux 服务器管理控制台', 'Linux Server Manager') : 'Linux Server Manager'}`;
      const hostEl = document.getElementById('titlebar-host');
      if (hostEl) hostEl.innerText = getServerTargetLabel(true);
      const statusHost = document.getElementById('statusbar-host');
      if (statusHost) statusHost.innerText = `${window.localize ? window.localize('主机', 'Host') : 'Host'}: ${getServerTargetLabel(true)}`;
      const terminalLabel = document.getElementById('terminal-session-label');
      if (terminalLabel) terminalLabel.innerText = `${window.localize ? window.localize('会话', 'Session') : 'Session'}: ${getServerTargetLabel(true)} (pty)`;
      const chatSubtitle = document.getElementById('chat-empty-subtitle');
      if (chatSubtitle) chatSubtitle.innerText = window.localize ? window.localize(`由 ${config.host} 上的本地推理服务驱动`, `Powered by the local inference service on ${config.host}`) : `Powered by the local inference service on ${config.host}`;

      const setHost = document.getElementById('setting-host');
      if (setHost) setHost.value = config.host || '192.168.1.128';
      const setPort = document.getElementById('setting-port');
      if (setPort) setPort.value = config.port || 22;
      const setUser = document.getElementById('setting-username');
      if (setUser) setUser.value = config.username || 'root';
      const setAuth = document.getElementById('setting-auth-type');
      if (setAuth) setAuth.value = config.authType || 'password';
      const setProfileId = document.getElementById('setting-profile-id');
      if (setProfileId) setProfileId.value = config.activeProfileId || '';

      const isKey = config.authType === 'key';
      const groupPassword = document.getElementById('group-password');
      const groupKey = document.getElementById('group-key');
      if (groupPassword) groupPassword.style.display = isKey ? 'none' : 'flex';
      if (groupKey) groupKey.style.display = isKey ? 'flex' : 'none';

      if (window.currentView === 'files' && typeof window.currentPath !== 'undefined') {
        renderAddressBarFiles(window.currentPath);
      } else {
        updateAddressBarForView(window.currentView || 'files');
      }
      await loadServerProfiles(config.activeProfileId);
    }
  } catch (e) {
    window.updateConnectionStatus(false);
  }
}

window.updateConnectionStatus = function (isConnected, uptimeText) {
  const statusItem = document.getElementById('statusbar-conn-status');
  const uptimeItem = document.getElementById('statusbar-uptime');
  const noticeBanner = document.getElementById('notice-disconnected');

  if (noticeBanner) {
    noticeBanner.style.display = isConnected ? 'none' : 'flex';
  }

  if (statusItem) {
    statusItem.innerText = isConnected
      ? (window.localize ? window.localize('● 已就绪 (在线)', '● Ready (online)') : '● Ready (online)')
      : (window.localize ? window.localize('○ 未连接 (离线)', '○ Disconnected (offline)') : '○ Disconnected (offline)');
    statusItem.style.color = isConnected ? '#89d185' : '#f14c4c';
  }
  if (uptimeItem && uptimeText) {
    uptimeItem.innerText = `${window.localize ? window.localize('开机', 'Uptime') : 'Uptime'}: ${uptimeText}`;
  }
};
