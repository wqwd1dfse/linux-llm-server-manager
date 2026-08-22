import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { parseCookies, verifyPassword } from '../server/auth.js';
import { loadAuthRecord } from '../server/authStore.js';
import { getConfig, saveConfig } from '../server/config.js';
import { writeJsonAtomic } from '../server/atomicFile.js';
import { isSupportedArchivePath } from '../server/archiveExtractor.js';
import { metricsCollector } from '../server/metricsCollector.js';
import { saveProfile, getProfile } from '../server/profileStore.js';
import { applySecurityHeaders } from '../server/securityHeaders.js';
import { verifyHostKey } from '../server/sshManager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..');

function withTempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Authentication rejects malformed records and cookies without expensive work or exceptions', () => {
  const validShape = {
    algorithm: 'pbkdf2-sha512',
    iterations: 220000,
    salt: 'a'.repeat(32),
    hash: 'b'.repeat(128)
  };

  assert.equal(verifyPassword('password', { ...validShape, iterations: 2_000_001 }), false);
  assert.equal(verifyPassword('password', { ...validShape, salt: '../invalid' }), false);
  assert.equal(verifyPassword('password', { ...validShape, hash: 'not-hex' }), false);
  assert.doesNotThrow(() => parseCookies('agm_session=%E0%A4%A; theme=dark'));
  assert.deepEqual(parseCookies('agm_session=%E0%A4%A; theme=dark'), { theme: 'dark' });
});

test('Atomic JSON writes replace content and leave no temporary artifacts', (t) => {
  const directory = withTempDirectory(t, 'llm-manager-atomic-');
  const target = path.join(directory, 'nested', 'record.json');
  writeJsonAtomic(target, { version: 1 });
  writeJsonAtomic(target, { version: 2, ok: true });

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2, ok: true });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['record.json']);
});

test('Configuration files load valid objects and refuse to overwrite malformed state', (t) => {
  const directory = withTempDirectory(t, 'llm-manager-config-');
  const configFile = path.join(directory, 'config.json');
  const previousPath = process.env.CONFIG_FILE_PATH;
  process.env.CONFIG_FILE_PATH = configFile;
  t.after(() => {
    if (previousPath === undefined) delete process.env.CONFIG_FILE_PATH;
    else process.env.CONFIG_FILE_PATH = previousPath;
  });

  fs.writeFileSync(configFile, JSON.stringify({ host: 'test-host', port: 2222 }), 'utf8');
  const loaded = getConfig();
  assert.equal(loaded.host, 'test-host');
  assert.equal(loaded.port, 2222);

  fs.writeFileSync(configFile, '[]', 'utf8');
  assert.throws(() => saveConfig({ host: 'must-not-overwrite' }), /已停止覆盖/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), '[]');

  fs.writeFileSync(configFile, '{malformed json', 'utf8');
  assert.throws(() => saveConfig({ host: 'must-not-overwrite' }), /已停止覆盖/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{malformed json');
});

test('SSH TOFU pins the first key, rejects a changed key by default, and only rotates when opted out', (t) => {
  const directory = withTempDirectory(t, 'llm-manager-known-hosts-');
  const knownHostsFile = path.join(directory, 'known-hosts.json');
  const previousFile = process.env.SSH_KNOWN_HOSTS_FILE;
  const previousStrict = process.env.SSH_STRICT_HOST_CHECK;
  process.env.SSH_KNOWN_HOSTS_FILE = knownHostsFile;
  process.env.SSH_STRICT_HOST_CHECK = 'true';
  t.after(() => {
    if (previousFile === undefined) delete process.env.SSH_KNOWN_HOSTS_FILE;
    else process.env.SSH_KNOWN_HOSTS_FILE = previousFile;
    if (previousStrict === undefined) delete process.env.SSH_STRICT_HOST_CHECK;
    else process.env.SSH_STRICT_HOST_CHECK = previousStrict;
  });

  assert.equal(verifyHostKey('model-host', 22, 'fingerprint-a', 'ssh-ed25519'), true);
  assert.equal(verifyHostKey('model-host', 22, 'fingerprint-a', 'ssh-ed25519'), true);
  assert.equal(verifyHostKey('model-host', 22, 'fingerprint-b', 'ssh-ed25519'), false);
  assert.equal(JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))['model-host:22'].fingerprint, 'fingerprint-a');

  process.env.SSH_STRICT_HOST_CHECK = 'false';
  assert.equal(verifyHostKey('model-host', 22, 'fingerprint-b', 'ssh-ed25519'), true);
  assert.equal(JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'))['model-host:22'].fingerprint, 'fingerprint-b');
  fs.writeFileSync(knownHostsFile, '{malformed json', 'utf8');
  process.env.SSH_STRICT_HOST_CHECK = 'true';
  assert.equal(verifyHostKey('model-host', 22, 'fingerprint-c', 'ssh-ed25519'), false);
});

test('Profile updates preserve omitted key-auth fields', (t) => {
  const directory = withTempDirectory(t, 'llm-manager-profiles-');
  const previousPath = process.env.SERVER_PROFILES_FILE;
  process.env.SERVER_PROFILES_FILE = path.join(directory, 'servers.json');
  t.after(() => {
    if (previousPath === undefined) delete process.env.SERVER_PROFILES_FILE;
    else process.env.SERVER_PROFILES_FILE = previousPath;
  });

  const created = saveProfile({
    name: 'GPU host',
    host: '192.0.2.10',
    port: 22,
    username: 'operator',
    authType: 'key',
    privateKey: 'PRIVATE KEY DATA'
  });
  saveProfile({ id: created.id, name: 'Renamed GPU host' });

  const stored = getProfile(created.id);
  assert.equal(stored.authType, 'key');
  assert.equal(stored.privateKey, 'PRIVATE KEY DATA');
  assert.equal(stored.name, 'Renamed GPU host');

  fs.writeFileSync(process.env.SERVER_PROFILES_FILE, '{malformed json', 'utf8');
  assert.throws(() => saveProfile({ id: created.id, name: 'Must not overwrite' }), /已停止覆盖/);
  assert.equal(fs.readFileSync(process.env.SERVER_PROFILES_FILE, 'utf8'), '{malformed json');
});

test('Archive format allowlist is explicit and excludes misleading suffixes', () => {
  for (const file of ['model.zip', 'model.tar', 'model.tar.gz', 'model.tgz', 'model.tar.bz2', 'model.tbz2', 'model.tar.xz', 'model.txz']) {
    assert.equal(isSupportedArchivePath(file), true, file);
  }
  for (const file of ['model.gz', 'model.rar', 'model.zip.exe', '../archive']) {
    assert.equal(isSupportedArchivePath(file), false, file);
  }
});

test('Metrics history retains accurate full-range stats while sampling endpoints for charts', (t) => {
  const previousHistory = metricsCollector.history;
  t.after(() => { metricsCollector.history = previousHistory; });
  const now = Date.now();
  metricsCollector.history = Array.from({ length: 240 }, (_, index) => ({
    t: now - (239 - index) * 1000,
    cpu: index,
    gpuJ: null,
    gpuE: null,
    gpuP: index / 10,
    fanRpm: null,
    cpuPwm: null
  }));

  metricsCollector.updateLatestHistory({
    cpu: 37,
    gpuJ: 39,
    gpuE: 37,
    gpuP: 17,
    fanRpm: 1500,
    cpuPwm: 42
  });
  const history = metricsCollector.getHistory('invalid-range');
  assert.equal(history.range, '5m');
  assert.equal(history.count, 120);
  assert.equal(history.points[0].cpu, 0);
  assert.equal(history.points.at(-1).cpu, 37);
  assert.equal(history.stats.cpu.avg, 118.7);
  assert.equal(history.stats.cpu.current, 37);
  assert.equal(history.stats.gpuJunction.current, 39);
  assert.equal(history.stats.gpuEdge.current, 37);
  assert.equal(history.stats.gpuPower.current, 17);
  assert.equal(history.stats.fanRpm.current, 1500);
});

test('Metrics WebSocket initial collection relies on the central broadcast exactly once', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'server', 'ws', 'metrics.js'), 'utf8');
  const immediateBlock = source.slice(source.indexOf('function sendImmediateSnapshot'));
  assert.match(immediateBlock, /metricsCollector\.collect\(\)\s*\n\s*\.catch/);
  assert.doesNotMatch(immediateBlock, /\.then\(\(data\)/);
});

test('Authentication refuses public example or undersized environment credentials', (t) => {
  const directory = withTempDirectory(t, 'llm-manager-auth-env-');
  const previousPath = process.env.AUTH_FILE_PATH;
  const previousPassword = process.env.ADMIN_PASSWORD;
  const previousUsername = process.env.ADMIN_USERNAME;
  process.env.AUTH_FILE_PATH = path.join(directory, 'auth.json');
  process.env.ADMIN_USERNAME = 'admin';

  t.after(() => {
    if (previousPath === undefined) delete process.env.AUTH_FILE_PATH;
    else process.env.AUTH_FILE_PATH = previousPath;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
    if (previousUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousUsername;
  });

  process.env.ADMIN_PASSWORD = 'your_secure_admin_password_here';
  assert.equal(loadAuthRecord(), null);
  assert.equal(fs.existsSync(process.env.AUTH_FILE_PATH), false);

  process.env.ADMIN_PASSWORD = 'too-short';
  assert.equal(loadAuthRecord(), null);
  assert.equal(fs.existsSync(process.env.AUTH_FILE_PATH), false);
});

test('Authentication refuses weak configured session-signing secrets at startup', () => {
  for (const secret of [
    'too-short',
    'replace_with_a_long_random_secret',
    'change_this_to_a_random_long_string_in_production'
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', "import './server/auth.js'"],
      {
        cwd: projectRoot,
        env: { ...process.env, SESSION_SECRET: secret },
        encoding: 'utf8'
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SESSION_SECRET/);
  }
});

test('Archive extraction enforces the actual streamed byte limit without extractall', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'server', 'archiveExtractor.js'), 'utf8');
  assert.match(source, /actual_bytes \+= len\(chunk\)/);
  assert.match(source, /actual_bytes > max_bytes/);
  assert.match(source, /tempfile\.mkstemp/);
  assert.match(source, /os\.replace\(temporary, target\)/);
  assert.doesNotMatch(source, /\.extractall\(/);
});

test('File mutations guard core directories and reject dot archive names', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'server', 'routes', 'files.js'), 'utf8');
  assert.match(source, /assertNotProtectedTopLevelSystemPath\(req\.body\.source, '移动'\)/);
  assert.match(source, /assertNotProtectedTopLevelSystemPath\(req\.body\.oldPath, '重命名'\)/);
  assert.match(source, /assertNotProtectedTopLevelSystemPath\(req\.body\.newPath, '重命名为新路径'\)/);
  assert.match(source, /assertNotProtectedTopLevelSystemPath\(req\.body\.path, '修改权限'\)/);
  assert.match(source, /archiveName === '\.' \|\| archiveName === '\.\.'/);
});

test('Security headers require an exact same-host origin and trusted HTTPS state', () => {
  const apply = (req) => {
    const headers = {};
    const res = {
      setHeader(name, value) { headers[name] = value; },
      status() { return this; },
      end() {}
    };
    applySecurityHeaders(req, res, () => {});
    return headers;
  };

  const spoofed = apply({
    secure: false,
    method: 'GET',
    headers: {
      origin: 'http://evil127.0.0.1:3888',
      host: '127.0.0.1:3888',
      'x-forwarded-proto': 'https'
    }
  });
  assert.equal(spoofed['Access-Control-Allow-Origin'], undefined);
  assert.equal(spoofed['Strict-Transport-Security'], undefined);

  const sameHost = apply({
    secure: true,
    method: 'GET',
    headers: { origin: 'https://admin.example:3888', host: 'admin.example:3888' }
  });
  assert.equal(sameHost['Access-Control-Allow-Origin'], 'https://admin.example:3888');
  assert.match(sameHost['Strict-Transport-Security'], /max-age=31536000/);
});

test('Markdown renderer escapes exactly once and keeps code blocks isolated from inline formatting', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'markdown.js'), 'utf8');
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const context = {
    window: { escapeHtml, localize: (_zh, en) => en },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    Math
  };
  vm.runInNewContext(source, context);

  const rendered = context.window.renderMarkdown('**safe**\n```html\n<x>&</x>\n```\n<img src=x onerror=alert(1)>');
  assert.match(rendered, /<strong>safe<\/strong>/);
  assert.match(rendered, /&lt;x&gt;&amp;&lt;\/x&gt;/);
  assert.doesNotMatch(rendered, /&amp;lt;x/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});

test('HTTP layer returns structured 400 and authenticated 404 responses', async (t) => {
  const directory = withTempDirectory(t, 'llm-manager-http-errors-');
  const previousAuthPath = process.env.AUTH_FILE_PATH;
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  process.env.AUTH_FILE_PATH = path.join(directory, 'auth.json');
  delete process.env.ADMIN_PASSWORD;
  process.env.AUTO_CONNECT = 'false';
  t.after(() => {
    if (previousAuthPath === undefined) delete process.env.AUTH_FILE_PATH;
    else process.env.AUTH_FILE_PATH = previousAuthPath;
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousAdminPassword;
  });

  const { server } = await import('../server/index.js');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;

  const request = (method, requestPath, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const malformed = await request('POST', '/api/auth/setup', '{bad json', {
    'Content-Type': 'application/json',
    'Content-Length': 9
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'Malformed request body');

  const setupBody = JSON.stringify({ username: 'admin', password: 'StrongHttpPassword2026!' });
  const setup = await request('POST', '/api/auth/setup', setupBody, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(setupBody)
  });
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  const status = await request('GET', '/api/auth/status', null, { Cookie: cookie });
  const missing = await request('GET', '/api/not-a-real-endpoint', null, {
    Cookie: cookie,
    'X-SSH-Target-Epoch': status.body.status.targetEpoch
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'API endpoint not found');
});

test('Remote operations validate and stop in safe side-effect order', () => {
  const filesRoute = fs.readFileSync(path.join(projectRoot, 'server', 'routes', 'files.js'), 'utf8');
  const llmRoute = fs.readFileSync(path.join(projectRoot, 'server', 'routes', 'llm.js'), 'utf8');

  const uploadBlock = filesRoute.slice(filesRoute.indexOf('for (const file of uploadedFiles)'), filesRoute.indexOf("router.post('/mkdir'"));
  assert.ok(uploadBlock.indexOf('sanitizeUploadFilename') < uploadBlock.indexOf('path.posix.join'));
  assert.ok(uploadBlock.indexOf('path.posix.join') < uploadBlock.indexOf('uploadLocalFile(localPath, remotePath)'));

  const startBlock = llmRoute.slice(llmRoute.indexOf("router.post('/start'"), llmRoute.indexOf("router.post('/stop'"));
  assert.ok(startBlock.indexOf('validateModelLaunchParams') < startBlock.indexOf('stopManagedLlamaServer'));
  assert.ok(startBlock.indexOf('validateHfRepoId') < startBlock.indexOf('stopManagedLlamaServer'));
  assert.ok(startBlock.indexOf('stopManagedLlamaServer') < startBlock.indexOf('launchLlamaServer'));

  const taskBlock = llmRoute.slice(llmRoute.indexOf("router.get('/hf/tasks'"), llmRoute.indexOf('// Cancel a download task'));
  const pruneIndex = taskBlock.indexOf('pruneDownloadTasks()');
  const currentTargetTasksIndex = taskBlock.indexOf('const tasks = downloadTasksByTarget.get(target.key)');
  const taskLoopIndex = taskBlock.indexOf('for (const [, task] of tasks.entries())');
  assert.ok(pruneIndex >= 0);
  assert.ok(pruneIndex < currentTargetTasksIndex);
  assert.ok(currentTargetTasksIndex < taskLoopIndex);
  assert.match(taskBlock, /await refreshDownloadTask\(task, target\.key\)/);
  assert.match(llmRoute, /if \(inspection\.status === 'completed' \|\| inspection\.status === 'error'\)[\s\S]*?task\.finishedAt = now/);
  assert.match(llmRoute, /const downloadTaskReaper = new DownloadTaskReaper\([\s\S]*?runWithSshTargetContext\(freshContext/);

  const cancelBlock = llmRoute.slice(llmRoute.indexOf("router.post('/hf/tasks/:id/cancel'"), llmRoute.indexOf('// 5. Start LLM'));
  assert.ok(cancelBlock.indexOf('const task = tasks.get(id)') < cancelBlock.indexOf('settleCanceledDownloadTask(task, target.key)'));
  assert.match(cancelBlock, /if \(foreignTask\)[\s\S]*?res\.status\(409\)/);

  const restartBlock = llmRoute.slice(llmRoute.indexOf("router.post('/restart'"), llmRoute.indexOf('// Get LLM Logs'));
  assert.ok(restartBlock.indexOf('activeInstance.pid = runResult.pid') < restartBlock.indexOf('activeInstance.launchedAt'));
  assert.doesNotMatch(restartBlock.match(/catch \(err\)[\s\S]*$/)?.[0] || '', /runResult/);
});
