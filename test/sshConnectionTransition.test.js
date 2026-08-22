import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';

import express from 'express';
import ssh2 from 'ssh2';

const { Server: SshServer } = ssh2;

import { getConfig, setRuntimeSshOverride } from '../server/config.js';
import {
  SshConnectionCoordinator,
  captureSshTargetContext,
  disconnect,
  executeCommand,
  getClient,
  getConnectionStatus,
  runWithSshTargetContext
} from '../server/sshManager.js';

async function startSshServer(label, password, activeHandshakeDelayMs = 0) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const hostKey = privateKey.export({ format: 'pem', type: 'pkcs1' });
  const clients = new Set();
  const connectionWaiters = [];
  let connectionNumber = 0;

  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    const currentConnection = ++connectionNumber;
    for (let index = connectionWaiters.length - 1; index >= 0; index -= 1) {
      if (connectionNumber >= connectionWaiters[index].target) {
        connectionWaiters[index].resolve();
        connectionWaiters.splice(index, 1);
      }
    }
    client.once('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (context.method !== 'password' || context.username !== 'manager' || context.password !== password) {
        context.reject();
        return;
      }
      const delay = currentConnection % 2 === 0 ? activeHandshakeDelayMs : 0;
      if (delay > 0) setTimeout(() => context.accept(), delay);
      else context.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write(`Linux ${label}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    get connectionCount() {
      return connectionNumber;
    },
    waitForConnection(target) {
      if (connectionNumber >= target) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { target, resolve };
        connectionWaiters.push(waiter);
        const timeout = setTimeout(() => {
          const index = connectionWaiters.indexOf(waiter);
          if (index >= 0) connectionWaiters.splice(index, 1);
          reject(new Error(`Timed out waiting for SSH connection ${target}`));
        }, 2_000);
        timeout.unref?.();
        waiter.resolve = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    },
    async close() {
      for (const client of clients) {
        try { client.end(); } catch (_) {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function startHttpApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function requestJson(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

function postJson(port, pathname, body) {
  return requestJson(port, 'POST', pathname, body);
}

test('SSH connection coordinator serializes transitions and rejects excess queued work', async () => {
  const coordinator = new SshConnectionCoordinator({ maxQueue: 1, queueTimeoutMs: 1_000 });
  const events = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = coordinator.run(async () => {
    events.push('first:start');
    markFirstStarted();
    await firstGate;
    events.push('first:end');
  });
  await firstStarted;

  const second = coordinator.run(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await assert.rejects(
    coordinator.run(async () => events.push('unexpected')),
    (error) => error.code === 'QUEUE_FULL'
  );
  assert.deepEqual(events, ['first:start']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('SSH route transitions connect before persistence and coordinate profile deletion', () => {
  const source = fs.readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');
  const connectBlock = source.slice(
    source.indexOf("router.post('/connect'"),
    source.indexOf('// 7. Saved server profiles')
  );
  const profileConnectBlock = source.slice(
    source.indexOf("router.post('/profiles/:id/connect'"),
    source.indexOf("router.delete('/profiles/:id'")
  );
  const profileDeleteBlock = source.slice(
    source.indexOf("router.delete('/profiles/:id'"),
    source.indexOf('// 8. Disconnect active SSH')
  );

  assert.match(source, /if \(busy\) res\.setHeader\('Retry-After', '1'\)/);
  assert.match(connectBlock, /await runSshConnectionTransition/);
  assert.ok(connectBlock.indexOf('await getClient') < connectBlock.indexOf('savedProfile = saveProfile'));
  assert.doesNotMatch(connectBlock, /\bdisconnect\(\)/);
  assert.match(profileConnectBlock, /await runSshConnectionTransition/);
  assert.ok(profileConnectBlock.indexOf('await getClient') < profileConnectBlock.indexOf('saveConfig'));
  assert.match(profileDeleteBlock, /await runSshConnectionTransition/);
});

test('getClient does not change runtime target when a custom candidate cannot be built', async (t) => {
  t.after(() => disconnect());
  const before = getConfig();

  await assert.rejects(
    getClient(true, {
      host: 'failed-candidate.invalid',
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      privateKey: '',
      passphrase: '',
      activeProfileId: 'failed-profile'
    }),
    /未配置 SSH 密码或私钥/
  );

  const after = getConfig();
  assert.equal(after.host, before.host);
  assert.equal(after.port, before.port);
  assert.equal(after.username, before.username);
  assert.equal(after.activeProfileId || null, before.activeProfileId || null);
});

test('same-target lazy reconnect succeeds on the initiating request', { timeout: 10_000 }, async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'manager-ssh-lazy-reconnect-'));
  const originalKnownHostsPath = process.env.SSH_KNOWN_HOSTS_FILE;
  process.env.SSH_KNOWN_HOSTS_FILE = path.join(tempDirectory, 'known-hosts.json');
  const password = 'LazyReconnectPassword2026!';
  const remote = await startSshServer('lazy-reconnect', password);
  setRuntimeSshOverride({
    host: '127.0.0.1',
    port: remote.port,
    username: 'manager',
    authType: 'password',
    password,
    privateKey: '',
    passphrase: '',
    activeProfileId: null
  });
  disconnect();

  t.after(async () => {
    disconnect();
    setRuntimeSshOverride(null);
    if (originalKnownHostsPath === undefined) delete process.env.SSH_KNOWN_HOSTS_FILE;
    else process.env.SSH_KNOWN_HOSTS_FILE = originalKnownHostsPath;
    await remote.close();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const context = captureSshTargetContext();
  const result = await runWithSshTargetContext(context, () => (
    executeCommand('uname', ['-a'], { timeoutMs: 3_000 })
  ));

  assert.equal(result.success, true);
  assert.match(result.stdout, /lazy-reconnect/);
});

test('SSH routes serialize target switches and keep runtime state truthful on failures', { timeout: 15_000 }, async (t) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'manager-ssh-transition-'));
  const originalEnvironment = new Map([
    ['CONFIG_FILE_PATH', process.env.CONFIG_FILE_PATH],
    ['SERVER_PROFILES_FILE', process.env.SERVER_PROFILES_FILE],
    ['SSH_KNOWN_HOSTS_FILE', process.env.SSH_KNOWN_HOSTS_FILE]
  ]);
  process.env.CONFIG_FILE_PATH = path.join(tempDirectory, 'config.json');
  process.env.SERVER_PROFILES_FILE = path.join(tempDirectory, 'profiles.json');
  process.env.SSH_KNOWN_HOSTS_FILE = path.join(tempDirectory, 'known-hosts.json');
  setRuntimeSshOverride(null);
  disconnect();

  const password = 'SshTransitionPassword2026!';
  const alpha = await startSshServer('alpha', password, 150);
  const bravo = await startSshServer('bravo', password, 150);
  const { getProfile, saveProfile } = await import('../server/profileStore.js');
  const profile = saveProfile({
    name: 'Bravo',
    host: '127.0.0.1',
    port: bravo.port,
    username: 'manager',
    authType: 'password',
    password
  });
  const { default: authRouter } = await import('../server/routes/auth.js');
  const httpServer = await startHttpApp(authRouter);
  const httpPort = httpServer.address().port;

  t.after(async () => {
    disconnect();
    setRuntimeSshOverride(null);
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    await Promise.all([alpha.close(), bravo.close()]);
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const alphaRequest = postJson(httpPort, '/api/auth/connect', {
    host: '127.0.0.1',
    port: alpha.port,
    username: 'manager',
    authType: 'password',
    password,
    remember: false
  });
  const bravoRequest = postJson(httpPort, `/api/auth/profiles/${profile.id}/connect`, {});
  const [alphaResponse, bravoResponse] = await Promise.all([alphaRequest, bravoRequest]);

  assert.equal(alphaResponse.status, 200);
  assert.equal(alphaResponse.body.success, true);
  assert.equal(bravoResponse.status, 200);
  assert.equal(bravoResponse.body.success, true);
  assert.doesNotMatch(alphaResponse.body.error || '', /superseded/i);
  assert.doesNotMatch(bravoResponse.body.error || '', /superseded/i);

  const configAfterParallelSwitches = getConfig();
  const statusAfterParallelSwitches = getConnectionStatus();
  assert.equal(
    statusAfterParallelSwitches.host,
    `${configAfterParallelSwitches.username}@${configAfterParallelSwitches.host}:${configAfterParallelSwitches.port}`
  );

  const queuedProfile = saveProfile({
    name: 'Queued Bravo',
    host: '127.0.0.1',
    port: bravo.port,
    username: 'manager',
    authType: 'password',
    password
  });
  const nextBravoConnection = bravo.connectionCount + 1;
  const queuedSwitch = postJson(httpPort, `/api/auth/profiles/${queuedProfile.id}/connect`, {});
  await bravo.waitForConnection(nextBravoConnection);
  const queuedDelete = requestJson(httpPort, 'DELETE', `/api/auth/profiles/${queuedProfile.id}`);
  const [queuedSwitchResponse, queuedDeleteResponse] = await Promise.all([queuedSwitch, queuedDelete]);
  assert.equal(queuedSwitchResponse.status, 200);
  assert.equal(queuedSwitchResponse.body.success, true);
  assert.equal(queuedDeleteResponse.status, 409);
  assert.equal(getConfig().activeProfileId, queuedProfile.id);
  assert.ok(getProfile(queuedProfile.id));

  // Make profile persistence fail after a successful transport switch.
  process.env.SERVER_PROFILES_FILE = tempDirectory;
  const persistenceFailure = await postJson(httpPort, '/api/auth/connect', {
    host: '127.0.0.1',
    port: alpha.port,
    username: 'manager',
    authType: 'password',
    password,
    remember: true,
    profileName: 'Cannot be persisted'
  });
  assert.equal(persistenceFailure.status, 200);
  assert.equal(persistenceFailure.body.success, true);
  assert.equal(persistenceFailure.body.persisted, false);
  assert.match(persistenceFailure.body.warning, /已连接.*未能完整保存/);
  assert.equal(getConfig().port, alpha.port);
  assert.equal(getConnectionStatus().host, `manager@127.0.0.1:${alpha.port}`);

  const beforeFailedCandidate = getConfig();
  const statusBeforeFailedCandidate = getConnectionStatus();
  const unavailable = http.createServer();
  unavailable.listen(0, '127.0.0.1');
  await once(unavailable, 'listening');
  const unavailablePort = unavailable.address().port;
  await new Promise((resolve) => unavailable.close(resolve));

  const failedCandidate = await postJson(httpPort, '/api/auth/connect', {
    host: '127.0.0.1',
    port: unavailablePort,
    username: 'manager',
    authType: 'password',
    password,
    remember: false
  });
  assert.equal(failedCandidate.status, 400);
  assert.equal(failedCandidate.body.success, false);
  assert.equal(getConfig().port, beforeFailedCandidate.port);
  assert.deepEqual(getConnectionStatus(), statusBeforeFailedCandidate);
});
