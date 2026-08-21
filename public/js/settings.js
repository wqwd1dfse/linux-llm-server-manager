// System Settings, Language, Themes, and Preferences Manager

window.initSettings = function () {
  loadPreferences();
  setupSettingsEvents();
};

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
  const savedTemp = localStorage.getItem('win-temp-alarm') || '80';
  const tempSel = document.getElementById('setting-temp-alarm');
  if (tempSel) tempSel.value = savedTemp;

  // 5. Hugging Face Defaults
  const mirrorToggle = document.getElementById('setting-hf-mirror');
  if (mirrorToggle) mirrorToggle.checked = localStorage.getItem('hf_mirror_enabled') === 'true';

  const dirInput = document.getElementById('setting-hf-dir');
  if (dirInput) dirInput.value = localStorage.getItem('hf_model_dir') || '/mnt/models';
}

function setupSettingsEvents() {

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
    const tempAlarm = document.getElementById('setting-temp-alarm')?.value || '80';
    const hfMirror = document.getElementById('setting-hf-mirror')?.checked;
    const hfDir = document.getElementById('setting-hf-dir')?.value.trim() || '/mnt/models';

    localStorage.setItem('win-lang', lang);
    localStorage.setItem('win-theme', theme);
    localStorage.setItem('win-poll-interval', interval);
    localStorage.setItem('win-temp-alarm', tempAlarm);
    localStorage.setItem('hf_mirror_enabled', hfMirror ? 'true' : 'false');
    localStorage.setItem('hf_model_dir', hfDir);

    if (window.setLanguage) window.setLanguage(lang);
    window.dispatchEvent(new CustomEvent('preferenceschange', { detail: { interval, tempAlarm } }));
    window.toast(lang === 'zh-CN' ? '✅ 系统与全局偏好设置已成功保存！' : '✅ Preferences successfully saved!', 'success');
  });
}
