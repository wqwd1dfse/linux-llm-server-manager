// Scripts & DevOps Toolbox Execution

const scriptsText = (zh, en) => window.localize ? window.localize(zh, en) : en;

window.initScripts = function () {
  loadPresets();
  setupScriptEvents();
};

window.addEventListener('languagechange', () => {
  if (window.currentView === 'scripts') loadPresets();
});

async function loadPresets() {
  const container = document.getElementById('scripts-list-container');
  if (!container) return;

  try {
    const res = await window.api.request('/api/scripts/presets');
    const presets = res.presets || [];
    const customEnabled = Boolean(res.customScriptsEnabled);

    const customSection = document.getElementById('custom-script-section');
    const customDisabledNotice = document.getElementById('custom-script-disabled-notice');
    if (customSection && customDisabledNotice) {
      if (customEnabled) {
        customSection.style.display = 'block';
        customDisabledNotice.style.display = 'none';
      } else {
        customSection.style.display = 'none';
        customDisabledNotice.style.display = 'block';
      }
    }

    container.innerHTML = '';
    for (const p of presets) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.padding = '12px';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';

      const left = document.createElement('div');

      const title = document.createElement('div');
      title.style.fontWeight = '600';
      title.style.fontSize = '13px';
      title.style.color = 'var(--win-text-primary)';
      title.textContent = p.title;
      left.appendChild(title);

      const desc = document.createElement('div');
      desc.style.fontSize = '11px';
      desc.style.color = 'var(--win-text-secondary)';
      desc.style.marginTop = '2px';
      desc.textContent = p.description;
      left.appendChild(desc);

      const cmd = document.createElement('div');
      cmd.style.fontFamily = 'var(--font-mono)';
      cmd.style.fontSize = '10px';
      cmd.style.color = 'var(--win-accent)';
      cmd.style.marginTop = '4px';
      cmd.style.background = 'var(--win-address-bg)';
      cmd.style.padding = '2px 6px';
      cmd.style.borderRadius = '3px';
      cmd.style.display = 'inline-block';
      cmd.textContent = p.command;
      left.appendChild(cmd);

      card.appendChild(left);

      const btn = document.createElement('button');
      btn.className = 'cmd-btn primary btn-sm';
      btn.textContent = '▶ 执行';
      btn.addEventListener('click', () => runPresetScript(p.id));
      card.appendChild(btn);

      container.appendChild(card);
    }
  } catch (err) {
    container.innerHTML = '<div style="color: var(--perf-red); padding: 10px;">' + scriptsText('无法加载预设脚本: ', 'Failed to load preset scripts: ') + window.escapeHtml(err.message) + '</div>';
  }
}

function setupScriptEvents() {
  document.getElementById('btn-run-custom-script')?.addEventListener('click', async () => {
    const input = document.getElementById('custom-script-input');
    const cmd = input?.value?.trim();
    if (!cmd) return window.toast('请输入要执行的指令', 'warning');

    await executeScriptRequest({ customCommand: cmd });
  });
}

async function runPresetScript(scriptId) {
  await executeScriptRequest({ scriptId });
}

async function executeScriptRequest(payload) {
  const outputEl = document.getElementById('script-output-console');
  if (outputEl) outputEl.textContent = '正在执行脚本，请稍候...\n';

  try {
    const res = await window.api.request('/api/scripts/run', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (outputEl) {
      outputEl.textContent = `[执行指令]: ${res.command}\n[执行状态]: 退出码 ${res.exitCode}\n\n--- 标准输出 (STDOUT) ---\n${res.stdout || '(无输出)'}\n\n--- 错误输出 (STDERR) ---\n${res.stderr || '(无错误)'}`;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  } catch (err) {
    if (outputEl) {
    outputEl.textContent = scriptsText('[执行失败]: ', '[Execution failed]: ') + err.message;
    }
  }
}

window.runPresetScript = runPresetScript;
