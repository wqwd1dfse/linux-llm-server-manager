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
  assert.match(fanInstaller, /systemctl enable --now fan-control\.service/);
});

test('Internationalization: English defaults and language switching preserve nested controls', () => {
  const i18n = read('public/js/i18n.js');
  const catalog = read('public/js/i18nCatalog.js');
  const settings = read('public/js/settings.js');
  const englishReadme = read('README.md');
  const chineseReadme = read('README.zh-CN.md');

  assert.match(shellHtml, /<html lang="en"/);
  assert.match(shellHtml, /<option value="en-US" selected>/);
  assert.match(i18n, /const DEFAULT_LANGUAGE = 'en-US'/);
  assert.match(settings, /localStorage\.getItem\('win-lang'\) \|\| 'en-US'/);
  assert.doesNotMatch(settings, /getElementById\('setting-lang-select'\)\?\.addEventListener\('change'/);
  assert.match(i18n, /setElementTextPreservingChildren/);
  assert.match(i18n, /MutationObserver/);
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
  const filesClient = read('public/js/files.js');
  const filesServer = read('server/routes/files.js');

  assert.match(shellHtml, /id="btn-toggle-file-favorite"/);
  assert.match(shellHtml, /id="btn-open-trash"/);
  assert.match(modalHtml, /id="modal-file-trash"/);
  assert.match(filesClient, /FILE_FAVORITES_PREFIX/);
  assert.match(filesClient, /refreshFileServerContext/);
  assert.match(filesServer, /movePathToTrash/);
  assert.match(filesServer, /router\.post\('\/trash\/:id\/restore'/);
  assert.match(filesServer, /router\.delete\('\/trash'/);
  assert.match(filesServer, /protectedPaths = \['\/', '\/bin', '\/boot'/);
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