import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const shellHtml = read('public/index.html');
const modalHtml = read('public/fragments/modals.html');
const combinedCss = [
  read('public/css/base.css'),
  read('public/css/components.css'),
  read('public/css/polish.css')
].join('\n');

test('Frontend hardening: no inline event handlers remain', () => {
  const sources = [
    shellHtml,
    modalHtml,
    ...fs.readdirSync(path.join(projectRoot, 'public', 'js'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => read(path.join('public', 'js', name)))
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i);
  }
});

test('Frontend hardening: responsive and accessible application shell', () => {
  assert.match(shellHtml, /class="skip-link"/);
  assert.match(shellHtml, /id="main-content"/);
  assert.match(shellHtml, /aria-live="polite"/);
  assert.match(combinedCss, /:focus-visible/);
  assert.match(combinedCss, /@media \(max-width: 820px\)/);
  assert.match(shellHtml, /class="hf-toolbar-row"/);
  assert.match(modalHtml, /class="hf-modal-toolbar"/);
  assert.match(combinedCss, /\.hf-toolbar-row,[\s\S]*?flex-direction: column !important/);
  assert.match(combinedCss, /\.llm-nav-tabs-bar\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(combinedCss, /\.llm-nav-tab\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(combinedCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test('Frontend architecture: modular styles and trusted modal fragment bootstrapping', () => {
  const styleEntry = read('public/css/style.css');
  const bootstrap = read('public/js/bootstrap.js');
  const terminal = read('public/js/terminal.js');
  const markdown = read('public/js/markdown.js');
  const llm = read('public/js/llm.js');
  const app = read('public/js/app.js');

  assert.match(styleEntry, /@import url\("base\.css"\)/);
  assert.match(styleEntry, /@import url\("components\.css"\)/);
  assert.match(styleEntry, /@import url\("polish\.css"\)/);
  assert.ok(shellHtml.indexOf('css/base.css') < shellHtml.indexOf('css/components.css'));
  assert.ok(shellHtml.indexOf('css/components.css') < shellHtml.indexOf('css/polish.css'));
  assert.match(shellHtml, /id="modal-root"/);
  assert.doesNotMatch(shellHtml, /id="modal-login"/);
  assert.match(modalHtml, /id="modal-login"/);
  assert.match(modalHtml, /id="modal-setup"/);
  assert.ok(shellHtml.indexOf('js/bootstrap.js') < shellHtml.indexOf('js/api.js'));
  assert.match(bootstrap, /hasInlineHandler/);
  assert.match(bootstrap, /root\.replaceChildren/);
  assert.doesNotMatch(shellHtml, /xterm(?:-addon-fit)?@/);
  assert.match(terminal, /ensureTerminalAssets/);
  assert.match(terminal, /XTERM_JS_URL/);
  assert.ok(app.indexOf('js/markdown.js') < app.indexOf('js/llm.js'));
  assert.match(markdown, /window\.renderMarkdown/);
  assert.doesNotMatch(llm, /function renderMarkdown/);
});

test('Frontend performance: feature scripts are loaded on demand', () => {
  const app = read('public/js/app.js');
  const featureScripts = [
    'settings.js',
    'dashboard.js',
    'terminal.js',
    'docker.js',
    'files.js',
    'services.js',
    'scripts.js',
    'markdown.js',
    'llm.js',
    'fan.js'
  ];

  for (const script of featureScripts) {
    const escapedScript = script.replace('.', '\\.');
    assert.doesNotMatch(shellHtml, new RegExp(`<script[^>]+src="js/${escapedScript}`));
    assert.match(app, new RegExp(`js/${escapedScript}`));
  }

  assert.match(app, /const featureBundles = Object\.freeze/);
  assert.match(app, /loadingViews\.has\(initKey\)/);
  assert.match(app, /await loadFeatureScript\(src\)/);
});

test('Frontend naming: hardware-specific labels stay out of visible copy', () => {
  const visibleMarkup = `${shellHtml}\n${modalHtml}`
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
  const catalog = read('public/js/i18nCatalog.js');
  const fanRoute = read('server/routes/fan.js');
  const fanClient = read('public/js/fan.js');
  const fanService = read('linux/fan-control/fan-control.service');
  const fanInstaller = read('linux/fan-control/install.sh');

  assert.doesNotMatch(visibleMarkup, /\b(?:P12|MI50)\b/i);
  assert.doesNotMatch(catalog, /\b(?:P12|MI50)\b/i);
  assert.match(fanRoute, /name: 'Fan 外置风扇'/);
  assert.match(fanRoute, /FAN_SERVICE_NAMES = \['fan-control', 'mi50-fan-control'\]/);
  assert.match(fanRoute, /target = requestedTarget === 'p12' \? 'fan'/);
  assert.match(fanRoute, /\n        fan: \{/);
  assert.match(fanRoute, /pwmPercent: gpuPwmPercent !== null \? gpuPwmPercent/);
  assert.doesNotMatch(fanClient, /fans\.p12|p12Rpm/);
  assert.match(fanClient, /requestSequence !== fanStatusRequestSequence/);
  assert.match(fanService, /ExecStart=\/usr\/local\/sbin\/fan-control\.sh/);
  assert.match(fanService, /ExecStopPost=\/usr\/local\/sbin\/fan-control\.sh --restore-auto/);
  assert.match(fanInstaller, /trap rollback EXIT/);
  assert.match(fanInstaller, /"\$SYSTEMCTL" enable "\$NEW_SERVICE"/);
  assert.match(fanInstaller, /"\$SYSTEMCTL" restart "\$NEW_SERVICE"/);
  assert.ok(fanInstaller.indexOf('if ! service_is_active "$NEW_SERVICE"') < fanInstaller.indexOf('"$SYSTEMCTL" disable "$LEGACY_SERVICE"'));
});

test('Internationalization: English defaults and language switching preserve nested controls', () => {
  const i18n = read('public/js/i18n.js');
  const catalog = read('public/js/i18nCatalog.js');
  const settings = read('public/js/settings.js');
  const dashboard = read('public/js/dashboard.js');
  const llm = read('public/js/llm.js');
  const englishReadme = read('README.md');
  const chineseReadme = read('README.zh-CN.md');

  assert.match(shellHtml, /<html lang="en"/);
  assert.match(shellHtml, /<option value="en-US" selected>/);
  assert.match(i18n, /const DEFAULT_LANGUAGE = 'en-US'/);
  assert.match(settings, /localStorage\.getItem\('win-lang'\) \|\| 'en-US'/);
  assert.doesNotMatch(settings, /getElementById\('setting-lang-select'\)\?\.addEventListener\('change'/);
  assert.match(i18n, /setElementTextPreservingChildren/);
  assert.match(i18n, /MutationObserver/);
  assert.match(i18n, /observer\.disconnect\(\)/);
  assert.match(i18n, /queueMicrotask/);
  assert.match(dashboard, /dashboardText/);
  assert.match(dashboard, /formatDashboardUptime/);
  assert.match(dashboard, /data\.os\?\.uptimeSeconds/);
  assert.match(dashboard, /diskDevicesBody\.replaceChildren/);
  assert.match(llm, /llmText/);
  assert.match(llm, /addEventListener\('languagechange'/);
  assert.match(shellHtml, /id="disk-devices-body"/);
  assert.match(shellHtml, /data-i18n="fan\.service_status"/);
  assert.match(shellHtml, /data-i18n="fan\.sample_rate"/);
  assert.match(shellHtml, /data-i18n="fan\.matrix_title"/);
  assert.match(shellHtml, /data-i18n="fan\.presets_title"/);
  assert.match(i18n, /'fan\.presets_title': '⚡ Cooling Presets'/);
  assert.doesNotMatch(i18n, /innerText\s*=\s*trans/);
  assert.match(catalog, /Linux Server Manager/);
  assert.match(englishReadme, /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(chineseReadme, /\[English\]\(README\.md\)/);
});

test('LLM Studio: launch presets, capacity estimate and restart parameter retention', () => {
  const llmClient = read('public/js/llm.js');
  const llmServer = read('server/routes/llm.js');

  assert.match(modalHtml, /id="start-model-preset"/);
  assert.match(modalHtml, /id="start-model-threads"/);
  assert.match(modalHtml, /id="start-model-parallel"/);
  assert.match(modalHtml, /id="llm-memory-estimate"/);
  assert.match(shellHtml, /id="llm-active-uptime"/);
  assert.match(shellHtml, /id="llm-active-resources"/);
  assert.match(llmClient, /LLM_LAUNCH_PRESETS/);
  assert.match(llmClient, /updateLlmMemoryEstimate/);
  assert.match(llmClient, /LLM_LAUNCH_SETTINGS_KEY/);
  assert.match(llmServer, /launchParams: validatedParams/);
  assert.match(llmServer, /launchLlamaServer\(\s*activeInstance\.source/);
  assert.doesNotMatch(llmServer, /nohup \$\{DEFAULT_LLAMA_BIN\} -m "\$\{activeInstance\.modelPath\}"/);
});
test('File manager: favorites and recoverable remote trash controls are wired', () => {
  const appClient = read('public/js/app.js');
  const filesClient = read('public/js/files.js');
  const filesServer = read('server/routes/files.js');
  const sftpManager = read('server/sftpManager.js');

  assert.match(shellHtml, /id="btn-toggle-file-favorite"/);
  assert.match(shellHtml, /id="btn-open-trash"/);
  assert.match(modalHtml, /id="modal-file-trash"/);
  assert.match(filesClient, /FILE_FAVORITES_PREFIX/);
  assert.match(filesClient, /refreshFileServerContext/);
  assert.match(filesClient, /window\.refreshCurrentFileList = function/);
  assert.doesNotMatch(filesClient, /getElementById\('cmd-btn-refresh'\).*addEventListener/s);
  assert.match(appClient, /window\.currentView === 'files'.*window\.refreshCurrentFileList/s);
  assert.match(filesClient, /window\.closeFileContextMenu = function/);
  assert.match(filesClient, /contextMenuInvoker.*\.focus\(\)/s);
  assert.match(shellHtml, /id="statusbar-conn-status" role="status" aria-live="polite"/);
  assert.doesNotMatch(shellHtml, /<footer class="win-statusbar"[^>]*aria-live/);
  assert.match(filesClient, /确定将此 \$\{label\} 移入回收站吗？可稍后恢复/);
  assert.match(filesClient, /确定将选中的 \$\{items\.length\} 个项目移入回收站吗？可稍后恢复/);
  assert.doesNotMatch(filesClient, /永久批量删除/);
  assert.match(filesClient, /async function handleSaveEditor\(\)[\s\S]*?catch \(_\) \{/);
  assert.match(filesServer, /movePathToTrash/);
  assert.match(filesServer, /router\.post\('\/trash\/:id\/restore'/);
  assert.match(filesServer, /router\.delete\('\/trash'/);
  assert.match(filesServer, /assertNotProtectedTopLevelSystemPath\(targetPath, '移入回收站'\)/);
  assert.match(sftpManager, /assertNotProtectedTopLevelSystemPath\(remotePath, '永久删除'\)/);
  assert.doesNotMatch(filesServer, /const protectedPaths\s*=/);
});

test('Multi-server: saved profiles and quick switching are wired without exposing credentials', () => {
  const appClient = read('public/js/app.js');
  const authRoutes = read('server/routes/auth.js');
  const profileStore = read('server/profileStore.js');

  assert.match(shellHtml, /id="server-quick-switch"/);
  assert.match(shellHtml, /id="server-profiles-list"/);
  assert.match(shellHtml, /id="setting-profile-id"/);
  assert.match(appClient, /connectServerProfile/);
  assert.match(authRoutes, /router\.get\('\/profiles'/);
  assert.match(authRoutes, /router\.post\('\/profiles\/:id\/connect'/);
  assert.match(profileStore, /function toSafeProfile/);
  assert.doesNotMatch(profileStore.match(/function toSafeProfile[\s\S]*?\n}/)?.[0] || '', /password:\s*profile\.password/);
});

test('Multi-server frontend: context epochs isolate stale requests and WebSocket sessions', () => {
  const app = read('public/js/app.js');
  const api = read('public/js/api.js');
  const files = read('public/js/files.js');
  const llm = read('public/js/llm.js');
  const dashboard = read('public/js/dashboard.js');
  const terminal = read('public/js/terminal.js');
  const fan = read('public/js/fan.js');
  const docker = read('public/js/docker.js');
  const services = read('public/js/services.js');
  const scripts = read('public/js/scripts.js');

  assert.match(app, /window\.serverContextEpoch\s*=\s*0/);
  assert.match(app, /new CustomEvent\('servercontextchange'/);
  assert.match(app, /forceContextChange:\s*true/);
  assert.doesNotMatch(app, /refreshViewsAfterServerSwitch/);
  assert.match(api, /err\.name\s*!==\s*'AbortError'/);
  assert.match(api, /X-SSH-Target-Epoch/);
  assert.match(api, /SSH_TARGET_STALE/);
  assert.match(app, /synchronizeServerTargetContext/);
  assert.match(app, /BroadcastChannel/);
  assert.match(app, /broadcastServerTargetEpoch/);

  assert.match(files, /addEventListener\('servercontextchange'/);
  assert.match(files, /fileListAbortController\?\.abort\(\)/);
  assert.match(files, /queueMicrotask\(\(\)\s*=>\s*loadFileList\(currentPath, false\)\)/);
  assert.match(files, /requestSequence\s*!==\s*fileListRequestSequence/);
  assert.match(files, /requestEpoch\s*!==\s*\(window\.getServerContextEpoch/);

  assert.match(llm, /function setupLocalModelsManager\(\)/);
  assert.match(llm, /localModelsAbortController\?\.abort\(\)/);
  assert.match(llm, /requestSequence\s*!==\s*localModelsRequestSequence/);
  assert.match(llm, /generationSequence\s*===\s*chatGenerationSequence/);
  assert.match(llm, /window\.loadLLMStatus\s*=\s*loadLLMStatus/);

  assert.match(dashboard, /function disconnectMetricsWs\(\)/);
  assert.match(dashboard, /withSshTargetEpochUrl/);
  assert.match(terminal, /withSshTargetEpochUrl/);
  assert.match(files, /getSshTargetRequestHeaders/);
  assert.match(llm, /getSshTargetRequestHeaders/);
  assert.match(dashboard, /function markDashboardDisconnected\(\)[\s\S]*?latestMetricsData\s*=\s*null;[\s\S]*?clearDashboardServerState\(\)/);
  assert.match(dashboard, /msg\.type === 'status'[\s\S]*?markDashboardDisconnected\(\)/);
  assert.match(dashboard, /socket\.onclose[\s\S]*?markDashboardDisconnected\(\)/);
  assert.match(dashboard, /connectionEpoch\s*!==\s*\(window\.getServerContextEpoch/);
  assert.match(dashboard, /socket\s*!==\s*metricsWs/);
  assert.match(terminal, /function disconnectTerminalWs\(\)/);
  assert.match(terminal, /socket\s*!==\s*termWs/);
  assert.match(fan, /requestEpoch\s*!==\s*\(window\.getServerContextEpoch/);
  assert.match(docker, /window\.loadDockerContainers\s*=\s*loadDockerContainers/);
  assert.match(docker, /addEventListener\('servercontextchange'/);
  assert.match(services, /window\.loadProcesses\s*=\s*loadProcesses/);
  assert.match(services, /addEventListener\('servercontextchange'/);
  assert.match(scripts, /scriptExecutionSequence/);
  assert.match(scripts, /addEventListener\('servercontextchange'/);
});

test('Frontend XSS hardening: remote host and telemetry values do not enter unsafe templates', () => {
  const app = read('public/js/app.js');
  const dashboard = read('public/js/dashboard.js');
  const fan = read('public/js/fan.js');
  const llm = read('public/js/llm.js');

  assert.match(app, /box\.replaceChildren\(serverCrumb, separator, viewCrumb\)/);
  assert.doesNotMatch(app, /box\.innerHTML\s*=\s*`<span>🖥️/);
  assert.match(dashboard, /function dashboardPercent\(value\)/);
  assert.doesNotMatch(dashboard, /\$\{g\.temperature\}/);
  assert.doesNotMatch(dashboard, /style="width:\s*\$\{d\.percent\}/);
  assert.match(fan, /function finiteFanNumber\(value\)/);
  assert.doesNotMatch(fan, /\$\{c\.temp\}/);
  assert.doesNotMatch(fan, /\$\{dk\.temp\}/);
  assert.match(llm, /function formatLlmCount\(value\)/);
  assert.doesNotMatch(llm, /\$\{\(m\.downloads\s*\|\|\s*0\)\.toLocaleString\(\)\}/);
});

test('LLM streaming: chunks append incrementally and Markdown renders once at completion', () => {
  const llm = read('public/js/llm.js');

  assert.match(llm, /const STREAM_RENDER_INTERVAL_MS\s*=\s*50/);
  assert.match(llm, /const scheduleStreamRender\s*=\s*\(\)\s*=>/);
  assert.match(llm, /requestAnimationFrame\(\(\)\s*=>/);
  assert.match(llm, /const flushStreamRender\s*=\s*\(options = \{\}\)\s*=>/);
  assert.match(llm, /answerStreamText\.appendData\(fullResponse\.slice\(streamedAnswerLength\)\)/);
  assert.match(llm, /flushStreamRender\(\{ final: true \}\)/);
  assert.match(llm, /cancelScheduledStreamRender\(\);\s*\n\s*if \(generationSequence === chatGenerationSequence\)/);
  assert.equal((llm.match(/renderMarkdown\(fullResponse\)/g) || []).length, 1);
});

test('LLM downloads: the saved Hugging Face model directory drives UI and requests', () => {
  const app = read('public/js/app.js');
  const settings = read('public/js/settings.js');
  const llm = read('public/js/llm.js');

  assert.match(shellHtml, /id="setting-hf-dir" value="\/mnt\/models"/);
  assert.match(app, /const DEFAULT_HF_MODEL_DIR\s*=\s*'\/mnt\/models'/);
  assert.match(app, /localStorage\.getItem\('hf_model_dir'\)/);
  assert.match(app, /window\.getAllowedHfModelRoots/);
  assert.match(app, /window\.resolveHfModelDir/);
  assert.match(settings, /window\.getHfModelDir\?\.\(\)/);
  assert.match(settings, /window\.resolveHfModelDir\?\.\(requestedHfDir\)/);
  assert.match(settings, /localStorage\.setItem\('hf_model_dir', hfDir\)/);
  assert.match(llm, /btnDl\.textContent\s*=\s*llmText\(`⬇️ 下载到 \$\{targetDir\}`/);
  assert.match(llm, /targetDir\s*=\s*window\.getHfModelDir\?\.\(\)\s*\|\|\s*window\.getDefaultHfModelDir\?\.\(\)/);
  assert.match(llm, /body:\s*JSON\.stringify\(\{[\s\S]*?targetDir[\s\S]*?\}\)/);
  assert.doesNotMatch(llm, /targetDir:\s*'\/mnt\/models'/);
});

test('Temperature alarm preference drives the fan chart and sensor colors', () => {
  const app = read('public/js/app.js');
  const settings = read('public/js/settings.js');
  const fan = read('public/js/fan.js');

  assert.match(app, /window\.getTemperatureAlarmThreshold\s*=\s*function/);
  assert.match(app, /ALLOWED_TEMPERATURE_ALARMS\.includes\(configured\)/);
  assert.match(app, /Object\.freeze\(\[75, 80, 85, 90\]\)/);
  assert.match(settings, /window\.getTemperatureAlarmThreshold\?\.\(\)/);
  assert.match(fan, /const alarmThreshold = window\.getTemperatureAlarmThreshold\?\.\(\) \|\| 80/);
  assert.match(fan, /alarmThreshold - 15/);
  assert.match(read('public/js/dashboard.js'), /temperature >= alarmThreshold/);
  assert.doesNotMatch(fan, /Alarm Line \(80°C\)/);
});

test('Hugging Face token controls persist without exposing or silently clearing secrets', () => {
  const settings = read('public/js/settings.js');
  const llm = read('public/js/llm.js');

  assert.match(shellHtml, /id="btn-clear-hf-token"/);
  assert.match(settings, /window\.api\.request\('\/api\/llm\/hf\/token'/);
  assert.match(settings, /if \(hfToken\) \{/);
  assert.match(settings, /JSON\.stringify\(\{ token: '' \}\)/);
  assert.doesNotMatch(settings, /localStorage\.setItem\([^\n]*hf[^\n]*token/i);
  assert.match(llm, /\.\.\.\(hfToken \? \{ hfToken \} : \{\}\)/);
  assert.match(llm, /tokenInput\.value = ''/);
});

test('SSH connection persistence warnings are surfaced instead of reported as saved', () => {
  const app = read('public/js/app.js');
  assert.match(app, /window\.toast\(res\.warning \|\| res\.message, res\.warning \? 'warning' : 'success'\)/);
  assert.match(app, /connectResult\.warning \|\| connectResult\.message \|\| fallbackMessage/);
  assert.match(app, /applyServerStatusPayload\(res, \{ forceContextChange: true, reason: 'profile-switch' \}\)/);
  assert.match(app, /applyServerStatusPayload\(connectResult, \{ forceContextChange: true, reason: 'ssh-connect' \}\)/);
  assert.match(app, /serverProfilesAbortController\?\.abort\(\)/);
});

test('Polling and modal reads cannot outlive their generation or SSH target', () => {
  const files = read('public/js/files.js');
  const llm = read('public/js/llm.js');
  const fan = read('public/js/fan.js');

  assert.match(llm, /pollingGeneration !== llmPollingGeneration/);
  assert.match(fan, /pollingGeneration !== fanPollingGeneration/);
  assert.match(llm, /llmLogsAbortController\?\.abort\(\)/);
  assert.match(fan, /fanLogsAbortController\?\.abort\(\)/);
  assert.match(files, /trashItemsAbortController\?\.abort\(\)/);
  assert.match(files, /filePropertiesAbortController\?\.abort\(\)/);
});
