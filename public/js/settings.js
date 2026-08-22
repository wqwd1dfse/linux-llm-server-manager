// System Settings, Language, Themes, and Preferences Manager

window.initSettings = function () {
  loadPreferences();
  setupSettingsEvents();
};

window.addEventListener('languagechange', () => {
  window.syncHfSettingsControls?.();
});

window.addEventListener('servercontextchange', () => {
  window.syncHfSettingsControls?.({ clearInput: true, syncDirectory: true });
});

function loadPreferences() {
  // 1. Language
  const savedLang = localStorage.getItem('win-lang') || 'en-US';
  const langSel = document.getElementById('setting-lang-select');
  if (langSel) langSel.value = savedLang;

  // 2. Theme
  const savedTheme = localStorage.getItem('win-theme') || 'dark';
  const themeSel = document.getElementById('setting-theme-select');
  if (themeSel) themeSel.value = savedTheme;

  // 3. Polling Interval
  const savedInterval = localStorage.getItem('win-poll-interval') || '2500';
  const pollSel = document.getElementById('setting-poll-interval');
  if (pollSel) pollSel.value = savedInterval;

  // 4. Temp Alarm Threshold
  const savedTemp = String(window.getTemperatureAlarmThreshold?.() || 80);
  const tempSel = document.getElementById('setting-temp-alarm');
  if (tempSel) tempSel.value = savedTemp;

  // 5. Hugging Face Defaults
  const mirrorToggle = document.getElementById('setting-hf-mirror');
  if (mirrorToggle) mirrorToggle.checked = localStorage.getItem('hf_mirror_enabled') === 'true';

  const dirInput = document.getElementById('setting-hf-dir');
  if (dirInput) dirInput.value = window.getHfModelDir?.() || '/mnt/models';

  updateHfTokenControls(Boolean(window.serverConnectionConfig?.hasHfToken), { clearInput: true });
}

function updateHfTokenControls(hasToken, { clearInput = false } = {}) {
  const tokenInput = document.getElementById('setting-hf-token');
  const clearButton = document.getElementById('btn-clear-hf-token');
  if (tokenInput) {
    if (clearInput) tokenInput.value = '';
    tokenInput.placeholder = hasToken
      ? (window.localize ? window.localize('已安全保存；留空保持不变', 'Saved securely; leave blank to keep it') : 'Saved securely; leave blank to keep it')
      : 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  }
  if (clearButton) clearButton.disabled = !hasToken;
}

window.syncHfSettingsControls = function syncHfSettingsControls({ clearInput = false, syncDirectory = false } = {}) {
  const mirrorToggle = document.getElementById('setting-hf-mirror');
  if (mirrorToggle) mirrorToggle.checked = localStorage.getItem('hf_mirror_enabled') === 'true';
  if (syncDirectory) {
    const dirInput = document.getElementById('setting-hf-dir');
    if (dirInput) dirInput.value = window.getHfModelDir?.() || window.getDefaultHfModelDir?.() || '/mnt/models';
  }
  updateHfTokenControls(Boolean(window.serverConnectionConfig?.hasHfToken), { clearInput });
};

function setupSettingsEvents() {

  document.getElementById('btn-clear-hf-token')?.addEventListener('click', async (event) => {
    const prompt = window.localize
      ? window.localize('确定清除已保存的 Hugging Face Token 吗？', 'Clear the saved Hugging Face token?')
      : 'Clear the saved Hugging Face token?';
    if (!confirm(prompt)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await window.api.request('/api/llm/hf/token', {
        method: 'POST',
        body: JSON.stringify({ token: '' })
      });
      if (window.serverConnectionConfig) window.serverConnectionConfig.hasHfToken = result.hasHfToken;
      window.syncHfSettingsControls({ clearInput: true });
      window.toast(window.localize ? window.localize('Hugging Face Token 已清除', 'Hugging Face token cleared') : 'Hugging Face token cleared', 'success');
    } catch (_) {
      button.disabled = false;
    }
  });

  // Theme Change
  document.getElementById('setting-theme-select')?.addEventListener('change', (e) => {
    const val = e.target.value;
    document.documentElement.setAttribute('data-theme', val);
    localStorage.setItem('win-theme', val);
    const icon = document.getElementById('theme-icon');
    const label = document.getElementById('theme-label');
    if (icon && label) {
      icon.innerText = val === 'dark' ? '☀️' : '🌙';
      label.innerText = val === 'dark' ? (window.t ? window.t('header.theme_light') : '浅色模式') : (window.t ? window.t('header.theme_dark') : '深色模式');
    }
  });

  // Save All Preferences
  document.getElementById('btn-save-preferences')?.addEventListener('click', async () => {
    const lang = document.getElementById('setting-lang-select')?.value || 'en-US';
    const theme = document.getElementById('setting-theme-select')?.value || 'dark';
    const interval = document.getElementById('setting-poll-interval')?.value || '2500';
    const requestedTempAlarm = document.getElementById('setting-temp-alarm')?.value || '80';
    const tempAlarm = ['75', '80', '85', '90'].includes(requestedTempAlarm) ? requestedTempAlarm : '80';
    const hfMirror = document.getElementById('setting-hf-mirror')?.checked;
    const requestedHfDir = document.getElementById('setting-hf-dir')?.value.trim()
      || window.getDefaultHfModelDir?.()
      || '/mnt/models';
    const hfDir = window.resolveHfModelDir?.(requestedHfDir) || null;
    if (!hfDir) {
      const roots = window.getAllowedHfModelRoots?.().join(', ') || '/mnt/models';
      window.toast(window.localize
        ? window.localize(`模型目录必须位于允许的根目录内：${roots}`, `Model directory must be inside an allowed root: ${roots}`)
        : `Model directory must be inside an allowed root: ${roots}`, 'error');
      return;
    }
    const hfTokenInput = document.getElementById('setting-hf-token');
    const hfToken = hfTokenInput?.value.trim() || '';
    const saveButton = document.getElementById('btn-save-preferences');
    if (saveButton) saveButton.disabled = true;

    try {
      if (hfToken) {
        const tokenResult = await window.api.request('/api/llm/hf/token', {
          method: 'POST',
          body: JSON.stringify({ token: hfToken })
        });
        if (window.serverConnectionConfig) window.serverConnectionConfig.hasHfToken = tokenResult.hasHfToken;
        window.syncHfSettingsControls({ clearInput: true });
      }

      localStorage.setItem('win-lang', lang);
      localStorage.setItem('win-theme', theme);
      localStorage.setItem('win-poll-interval', interval);
      localStorage.setItem('win-temp-alarm', tempAlarm);
      localStorage.setItem('hf_mirror_enabled', hfMirror ? 'true' : 'false');
      localStorage.setItem('hf_model_dir', hfDir);

      if (window.setLanguage) window.setLanguage(lang);
      window.dispatchEvent(new CustomEvent('preferenceschange', { detail: { interval, tempAlarm, hfDir, hfMirror } }));
      window.toast(lang === 'zh-CN' ? '✅ 系统与全局偏好设置已成功保存！' : '✅ Preferences successfully saved!', 'success');
    } catch (_) {
      // The shared API helper already reports the validation or network error.
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });
}
