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

  assert.match(styleEntry, /@import url\("base\.css"\)/);
  assert.match(styleEntry, /@import url\("components\.css"\)/);
  assert.match(styleEntry, /@import url\("polish\.css"\)/);
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
  assert.ok(shellHtml.indexOf('js/markdown.js') < shellHtml.indexOf('js/llm.js'));
  assert.match(markdown, /window\.renderMarkdown/);
  assert.doesNotMatch(llm, /function renderMarkdown/);
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