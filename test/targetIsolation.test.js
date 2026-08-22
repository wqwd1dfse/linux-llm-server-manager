import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import llmRouter, {
  CANCEL_DOWNLOAD_SCRIPT,
  DOWNLOAD_LAUNCH_SCRIPT,
  DOWNLOAD_STATUS_SCRIPT,
  DOWNLOAD_TRANSFER_SCRIPT,
  DownloadTaskReaper,
  LIST_MANAGED_RUNTIME_DIRS_SCRIPT,
  MAX_TARGET_SCOPED_STATES,
  READ_MANAGED_RUNTIME_STATE_SCRIPT,
  TargetLifecycleMutex,
  TargetScopedStore,
  applyDownloadInspection,
  assertDownloadInitializationActive,
  assertLlamaLaunchPortAvailable,
  cancelTargetDownloadTask,
  inspectManagedDownloadProcess,
  parseListeningTcpPorts,
  parseLlamaServerProbe,
  parseRecoveredDownloadState,
  parseRecoveredLlamaState,
  readBoundedResponseText,
  requestDownloadCancellation,
  resolveMaxActiveModelDownloads,
  resolveSshTargetIdentity,
  runCoalescedTargetScan,
  settleCanceledDownloadTask,
  terminateManagedLlamaProcess,
  validateHfAccessToken
} from '../server/routes/llm.js';
import {
  GPU_CACHE_MAX_TARGETS,
  detectGpus,
  resetGpuDetectionCache,
  resolveGpuTargetIdentity
} from '../server/gpuDetector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const posixTestShell = process.env.POSIX_TEST_SHELL || 'sh';

function targetConfig(host, username = 'root', port = 22) {
  return { host, username, port };
}

function connectedStatus(config) {
  return {
    connected: true,
    host: `${config.username}@${config.host}:${config.port}`
  };
}

function llmRouteHandler(routePath, method = 'get') {
  const layer = llmRouter.stack.find((item) => item.route?.path === routePath && item.route.methods?.[method]);
  assert.ok(layer, `missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('LLM target identity fails closed while config and active SSH client disagree', () => {
  const oldConfig = targetConfig('host-a');
  const newConfig = targetConfig('host-b');

  assert.deepEqual(
    resolveSshTargetIdentity(connectedStatus(oldConfig), oldConfig),
    { key: JSON.stringify(['root', 'host-a', 22]), label: 'root@host-a:22' }
  );
  assert.throws(
    () => resolveSshTargetIdentity(connectedStatus(oldConfig), newConfig),
    (error) => error.code === 'SSH_TARGET_CHANGING'
  );
});

test('TargetScopedStore keeps running state isolated per SSH target', () => {
  const store = new TargetScopedStore((targetIdentity) => ({ targetIdentity, pid: null }));
  store.get('host-a').pid = '101';
  store.get('host-b').pid = '202';

  assert.equal(store.get('host-a').pid, '101');
  assert.equal(store.get('host-b').pid, '202');
  assert.notEqual(store.get('host-a'), store.get('host-b'));
});

test('TargetScopedStore bounds idle targets with LRU eviction and refuses to forget active state', () => {
  const store = new TargetScopedStore(
    (targetIdentity) => ({ targetIdentity, active: false }),
    { maxEntries: 2, canEvict: (value) => !value.active }
  );
  store.get('host-a');
  store.get('host-b');
  store.get('host-a');
  store.get('host-c');
  assert.equal(store.peek('host-b'), null);
  assert.equal(store.peek('host-a').targetIdentity, 'host-a');
  assert.equal(store.peek('host-c').targetIdentity, 'host-c');

  store.get('host-a').active = true;
  store.get('host-c').active = true;
  assert.throws(
    () => store.get('host-d'),
    (error) => error.code === 'TARGET_STATE_CAPACITY'
  );
  assert.equal(MAX_TARGET_SCOPED_STATES, 32);
});

test('LLM lifecycle mutex rejects overlap per target while allowing different targets', async () => {
  const mutex = new TargetLifecycleMutex();
  let releaseHostA;
  const hostAGate = new Promise((resolve) => { releaseHostA = resolve; });
  const firstHostA = mutex.run('host-a', () => hostAGate);

  await assert.rejects(
    mutex.run('host-a', async () => 'must-not-run'),
    (error) => error.code === 'LLM_LIFECYCLE_BUSY'
  );
  assert.equal(await mutex.run('host-b', async () => 'host-b-ran'), 'host-b-ran');
  releaseHostA('host-a-finished');
  assert.equal(await firstHostA, 'host-a-finished');
  assert.equal(await mutex.run('host-a', async () => 'host-a-released'), 'host-a-released');
});

test('Model download concurrency defaults low and cannot be configured above 32', () => {
  assert.equal(resolveMaxActiveModelDownloads({}), 4);
  assert.equal(resolveMaxActiveModelDownloads({ MAX_ACTIVE_MODEL_DOWNLOADS: '3' }), 3);
  assert.equal(resolveMaxActiveModelDownloads({ MAX_ACTIVE_MODEL_DOWNLOADS: '32' }), 32);
  assert.equal(resolveMaxActiveModelDownloads({ MAX_ACTIVE_MODEL_DOWNLOADS: '33' }), 4);
  assert.equal(resolveMaxActiveModelDownloads({ MAX_ACTIVE_MODEL_DOWNLOADS: 'invalid' }), 4);
});

test('External llama probes require model data and llama metadata endpoints', () => {
  const valid = parseLlamaServerProbe(
    { success: true, stdout: JSON.stringify({ data: [{ id: 'external-model' }] }) },
    { success: true, stdout: JSON.stringify({ default_generation_settings: {} }) },
    { success: true, stdout: JSON.stringify([{ id: 0 }]) }
  );
  assert.equal(valid.healthy, true);
  assert.equal(valid.modelsJson.data[0].id, 'external-model');
  assert.equal(valid.slots[0].id, 0);

  assert.equal(parseLlamaServerProbe(
    { success: true, stdout: '<html>unrelated service</html>' },
    { success: true, stdout: '{}' },
    { success: true, stdout: '[]' }
  ).healthy, false);
  assert.equal(parseLlamaServerProbe(
    { success: true, stdout: JSON.stringify({ data: [] }) },
    { success: true, stdout: '{}' },
    { success: true, stdout: '[]' }
  ).healthy, false);
});

test('Listening TCP port parsing handles IPv4, IPv6 and wildcard addresses', () => {
  const ports = parseListeningTcpPorts([
    'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*',
    'LISTEN 0 128 [::]:9090 [::]:*',
    'LISTEN 0 64 *:3888 *:*'
  ].join('\n'));
  assert.deepEqual([...ports].sort((a, b) => a - b), [3888, 8080, 9090]);
});

test('LLM launch refuses an occupied listening port before starting a process', async () => {
  const calls = [];
  await assert.rejects(
    assertLlamaLaunchPortAvailable(8080, async (executable, argv) => {
      calls.push({ executable, argv });
      return { success: true, stdout: 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*\n', stderr: '' };
    }),
    error => error?.code === 'LLM_PORT_IN_USE'
  );
  assert.deepEqual(calls, [{ executable: 'ss', argv: ['-H', '-ltn'] }]);
});

test('Local model scans coalesce per target and release the in-flight promise', async () => {
  const hostA = { scanPromise: null };
  const hostB = { scanPromise: null };
  let hostACalls = 0;
  let hostBCalls = 0;
  let releaseHostA;
  const hostAGate = new Promise((resolve) => { releaseHostA = resolve; });

  const firstHostA = runCoalescedTargetScan(hostA, async () => {
    hostACalls += 1;
    await hostAGate;
    return 'host-a-result';
  });
  const secondHostA = runCoalescedTargetScan(hostA, async () => {
    hostACalls += 1;
    return 'must-not-run';
  });
  const hostBResult = await runCoalescedTargetScan(hostB, async () => {
    hostBCalls += 1;
    return 'host-b-result';
  });

  assert.strictEqual(firstHostA, secondHostA);
  assert.equal(hostACalls, 1);
  assert.equal(hostBCalls, 1);
  assert.equal(hostBResult, 'host-b-result');
  assert.equal(hostB.scanPromise, null);

  releaseHostA();
  assert.deepEqual(await Promise.all([firstHostA, secondHostA]), ['host-a-result', 'host-a-result']);
  assert.equal(hostA.scanPromise, null);
  assert.equal(await runCoalescedTargetScan(hostA, async () => {
    hostACalls += 1;
    return 'fresh-result';
  }), 'fresh-result');
  assert.equal(hostACalls, 2);

  await assert.rejects(
    runCoalescedTargetScan(hostA, () => { throw new Error('scan failed'); }),
    /scan failed/
  );
  assert.equal(hostA.scanPromise, null);
});

test('Managed llama termination never calls the executor for a foreign target', async () => {
  let calls = 0;
  const result = await terminateManagedLlamaProcess(
    { targetIdentity: 'host-a', pid: '123', pidStartTime: '456', ownershipToken: 'llm-owner-a' },
    'host-b',
    async () => {
      calls += 1;
      return { success: true, stdout: 'STATUS:STOPPED', stderr: '' };
    }
  );

  assert.deepEqual(result, { stopped: false, reason: 'target-mismatch' });
  assert.equal(calls, 0);
});

test('Managed llama termination validates executable and PID start time before signaling', async () => {
  let invocation;
  const instance = {
    targetIdentity: 'host-a',
    pid: '123',
    pidStartTime: '456',
    ownershipToken: 'llm-owner-a'
  };
  const result = await terminateManagedLlamaProcess(instance, 'host-a', async (...args) => {
    invocation = args;
    return { success: true, stdout: 'STATUS:STOPPED', stderr: '' };
  });

  assert.equal(result.stopped, true);
  assert.equal(invocation[0], 'sh');
  assert.match(invocation[1][1], /actual_start/);
  assert.match(invocation[1][1], /\/proc\/\$pid\/exe/);
  assert.match(invocation[1][1], /LLM_MANAGER_PROCESS_TOKEN/);
  assert.match(invocation[1][1], /if identity_matches; then[\s\S]*?kill -KILL/);
  assert.deepEqual(invocation[1].slice(-4), [
    '123', '/opt/llama.cpp/build/bin/llama-server', '456', 'llm-owner-a'
  ]);

  await assert.rejects(
    terminateManagedLlamaProcess(instance, 'host-a', async () => ({
      success: false,
      code: 42,
      stdout: 'STATUS:IDENTITY_MISMATCH',
      stderr: ''
    })),
    (error) => error.code === 'MANAGED_PROCESS_IDENTITY_MISMATCH'
  );
});

test('Download cancellation cannot signal or clean files on another SSH target', async () => {
  let calls = 0;
  const runtimeDir = '/tmp/llm-manager-download.Abc123xyz';
  const task = {
    targetIdentity: 'host-a',
    pid: '321',
    pidStartTime: '654',
    ownershipToken: 'download-owner-a',
    partFile: '/mnt/models/model.gguf.part',
    tokenConfigPath: `${runtimeDir}/curl.conf`,
    logFile: `${runtimeDir}/download.log`,
    statePath: `${runtimeDir}/state.json`,
    identityPath: `${runtimeDir}/identity`,
    exitStatusPath: `${runtimeDir}/exit-status`,
    completionPath: `${runtimeDir}/completed`,
    exitStatusTempPath: `${runtimeDir}/exit-status.tmp`,
    completionTempPath: `${runtimeDir}/completed.tmp`,
    runtimeDir
  };

  const foreignResult = await cancelTargetDownloadTask(task, 'host-b', async () => {
    calls += 1;
    return { success: true, stdout: 'STATUS:CANCELED', stderr: '' };
  });
  assert.deepEqual(foreignResult, { canceled: false, reason: 'target-mismatch' });
  assert.equal(calls, 0);

  const ownResult = await cancelTargetDownloadTask(task, 'host-a', async (...args) => {
    calls += 1;
    assert.match(args[1][1], /IDENTITY_MISMATCH/);
    assert.match(args[1][1], /LLM_MANAGER_DOWNLOAD_TOKEN/);
    assert.match(args[1][1], /if identity_matches; then[\s\S]*?pkill -KILL -P/);
    assert.deepEqual(args[1].slice(-14), [
      '321', '654', '/mnt/models/model.gguf.part', `${runtimeDir}/curl.conf`,
      '/mnt/models/model.gguf.part', `${runtimeDir}/download.log`, 'download-owner-a', runtimeDir,
      `${runtimeDir}/state.json`, `${runtimeDir}/identity`, `${runtimeDir}/exit-status`,
      `${runtimeDir}/completed`, `${runtimeDir}/exit-status.tmp`, `${runtimeDir}/completed.tmp`
    ]);
    return { success: true, stdout: 'STATUS:CANCELED', stderr: '' };
  });
  assert.deepEqual(ownResult, { canceled: true });
  assert.equal(calls, 1);
});

test('Persisted llama state recovers only for the exact target and private runtime directory', () => {
  const targetIdentity = JSON.stringify(['root', 'host-a', 22]);
  const runtimeDir = '/tmp/llm-manager-llama.Abc123xyz';
  const ownershipToken = '11111111-1111-4111-8111-111111111111';
  const rawState = JSON.stringify({
    version: 1,
    kind: 'llama',
    targetIdentity,
    ownershipToken,
    runtimeDir,
    source: 'file',
    modelPath: '/mnt/models/recovered.gguf',
    launchParams: {
      alias: 'recovered-model',
      ngl: 99,
      ctx: 4096,
      ctk: 'q8_0',
      ctv: 'q8_0',
      port: 8080,
      threads: null,
      parallel: null,
      fa: true
    },
    launchedAt: 1_700_000_000_000
  });

  const recovered = parseRecoveredLlamaState(rawState, '123 456\n', targetIdentity, runtimeDir);
  assert.equal(recovered.pid, '123');
  assert.equal(recovered.pidStartTime, '456');
  assert.equal(recovered.ownershipToken, ownershipToken);
  assert.equal(recovered.modelPath, '/mnt/models/recovered.gguf');
  assert.equal(recovered.statePath, `${runtimeDir}/state.json`);

  assert.throws(
    () => parseRecoveredLlamaState(rawState, '123 456', JSON.stringify(['root', 'host-b', 22]), runtimeDir),
    /does not belong/
  );
  assert.throws(
    () => parseRecoveredLlamaState(rawState, '123 456', targetIdentity, '/tmp/not-manager-owned'),
    /Invalid private runtime directory/
  );
  assert.throws(
    () => parseRecoveredLlamaState(rawState, '123 0', targetIdentity, runtimeDir),
    /identity is invalid/
  );
});

test('Persisted download state is target-scoped and binds its unique part file', () => {
  const targetIdentity = JSON.stringify(['root', 'host-a', 22]);
  const runtimeDir = '/tmp/llm-manager-download.Abc123xyz';
  const id = 'task_22222222-2222-4222-8222-222222222222';
  const destFile = '/mnt/models/recovered.gguf';
  const baseRecord = {
    version: 1,
    kind: 'download',
    targetIdentity,
    targetLabel: 'root@host-a:22',
    ownershipToken: '33333333-3333-4333-8333-333333333333',
    runtimeDir,
    id,
    repo: 'owner/repo',
    filename: 'recovered.gguf',
    destFile,
    partFile: `${destFile}.${id}.part`,
    downloadUrl: 'https://huggingface.co/owner/repo/resolve/main/recovered.gguf',
    totalBytes: 1024,
    startTime: 1_700_000_000_000,
    hasTokenConfig: true
  };

  const recovered = parseRecoveredDownloadState(
    JSON.stringify(baseRecord),
    '789 987',
    targetIdentity,
    runtimeDir
  );
  assert.equal(recovered.status, 'downloading');
  assert.equal(recovered.partFile, `${destFile}.${id}.part`);
  assert.equal(recovered.tokenConfigPath, `${runtimeDir}/curl.conf`);

  assert.throws(
    () => parseRecoveredDownloadState(
      JSON.stringify({ ...baseRecord, partFile: `${destFile}.shared.part` }),
      '789 987',
      targetIdentity,
      runtimeDir
    ),
    /temporary file is invalid/
  );
  assert.throws(
    () => parseRecoveredDownloadState(
      JSON.stringify(baseRecord),
      '789 987',
      JSON.stringify(['root', 'host-b', 22]),
      runtimeDir
    ),
    /does not belong/
  );
});

test('Download inspection requires the task completion contract, not destination existence', async () => {
  const runtimeDir = '/tmp/llm-manager-download.Abc123xyz';
  const task = {
    targetIdentity: 'host-a',
    pid: '123',
    pidStartTime: '456',
    ownershipToken: '44444444-4444-4444-8444-444444444444',
    partFile: '/mnt/models/model.gguf.task.part',
    destFile: '/mnt/models/model.gguf',
    runtimeDir,
    completionPath: `${runtimeDir}/completed`,
    exitStatusPath: `${runtimeDir}/exit-status`
  };
  let invocation;
  const failed = await inspectManagedDownloadProcess(task, 'host-a', async (...args) => {
    invocation = args;
    return { success: true, stdout: 'SIZE:512\nSTATUS:FAILED\n', stderr: '' };
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.downloadedBytes, 512);
  assert.match(invocation[1][1], /completion_token/);
  assert.match(invocation[1][1], /exit_status/);
  assert.doesNotMatch(invocation[1][1], /FINAL:/);

  const completed = await inspectManagedDownloadProcess(task, 'host-a', async () => ({
    success: true,
    stdout: 'SIZE:2048\nSTATUS:COMPLETED\n',
    stderr: ''
  }));
  assert.equal(completed.status, 'completed');
  applyDownloadInspection(task, completed, 10_000);
  assert.equal(task.status, 'completed');
  assert.equal(task.percent, 100);
  assert.equal(task.pid, null);
});

test('Starting download cancellation closes the launch gate and awaits verified cleanup', async () => {
  const task = { targetIdentity: 'host-a', status: 'starting', cancelRequested: false, cleanupComplete: false, pid: null };
  assert.doesNotThrow(() => assertDownloadInitializationActive(task));
  requestDownloadCancellation(task);
  assert.equal(task.status, 'canceling');
  assert.throws(
    () => assertDownloadInitializationActive(task),
    (error) => error.code === 'DOWNLOAD_CANCELED'
  );
  let cleanupFinished = false;
  await settleCanceledDownloadTask(task, 'host-a', {
    async cleanupFiles() {
      await new Promise((resolve) => setImmediate(resolve));
      cleanupFinished = true;
    }
  });
  assert.equal(cleanupFinished, true);
  assert.equal(task.cleanupComplete, true);
  assert.equal(task.status, 'canceled');

  const failedCleanup = { ...task, cleanupComplete: false, status: 'canceling' };
  await assert.rejects(
    settleCanceledDownloadTask(failedCleanup, 'host-a', {
      async cleanupFiles() { throw new Error('cleanup verification failed'); }
    }),
    /cleanup verification failed/
  );
  assert.equal(failedCleanup.cleanupComplete, false);
});

test('Background download reaper releases a finished task without a status request', async () => {
  const callbacks = [];
  const task = { id: 'task-test', status: 'downloading' };
  let refreshCalls = 0;
  const reaper = new DownloadTaskReaper(async (item, targetIdentity) => {
    refreshCalls += 1;
    assert.equal(targetIdentity, 'host-a');
    item.status = 'completed';
  }, {
    intervalMs: 1,
    setTimer(callback) {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimer() {}
  });

  reaper.watch(task, 'host-a');
  assert.equal(callbacks.length, 1);
  await callbacks.shift()();
  assert.equal(refreshCalls, 1);
  assert.equal(task.status, 'completed');
  assert.equal(callbacks.length, 0);
  assert.equal(reaper.timers.size, 0);
});

test('Download shell contract cannot mistake an old destination for a failed transfer', {
  skip: process.platform === 'win32' && !process.env.POSIX_TEST_SHELL ? 'requires POSIX sh' : false
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-download-contract-'));
  try {
    for (const script of [
      LIST_MANAGED_RUNTIME_DIRS_SCRIPT,
      READ_MANAGED_RUNTIME_STATE_SCRIPT,
      DOWNLOAD_LAUNCH_SCRIPT,
      DOWNLOAD_STATUS_SCRIPT,
      DOWNLOAD_TRANSFER_SCRIPT,
      CANCEL_DOWNLOAD_SCRIPT
    ]) {
      const syntax = spawnSync(posixTestShell, ['-n', '-c', script], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    const binDir = path.join(directory, 'bin');
    fs.mkdirSync(binDir);
    const fakeCurl = path.join(binDir, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nexit 22\n', { mode: 0o700 });
    const partFile = path.join(directory, 'model.task.part');
    const finalFile = path.join(directory, 'model.gguf');
    const exitStatusFile = path.join(directory, 'exit-status');
    const completionFile = path.join(directory, 'completed');
    const ownershipToken = '55555555-5555-4555-8555-555555555555';
    fs.writeFileSync(partFile, 'partial-new-data');
    fs.writeFileSync(finalFile, 'known-old-data');
    fs.writeFileSync(`${exitStatusFile}.tmp`, '', { mode: 0o600 });
    fs.writeFileSync(`${completionFile}.tmp`, '', { mode: 0o600 });

    const transfer = spawnSync(
      posixTestShell,
      ['-c', DOWNLOAD_TRANSFER_SCRIPT, 'sh', '', partFile, finalFile, exitStatusFile, completionFile, 'ignored'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          LLM_MANAGER_DOWNLOAD_TOKEN: ownershipToken
        }
      }
    );
    assert.notEqual(transfer.status, 0);
    assert.equal(fs.readFileSync(finalFile, 'utf8'), 'known-old-data');
    assert.equal(fs.existsSync(completionFile), false);
    assert.equal(fs.readFileSync(exitStatusFile, 'utf8').trim(), '1');

    const status = spawnSync(
      posixTestShell,
      [
        '-c', DOWNLOAD_STATUS_SCRIPT, 'sh', partFile, finalFile,
        '99999999', '1', partFile, ownershipToken, completionFile, exitStatusFile
      ],
      { encoding: 'utf8' }
    );
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /STATUS:FAILED/);
    assert.doesNotMatch(status.stdout, /STATUS:COMPLETED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('GPU discovery caches and reuses data only within the same SSH target', async (t) => {
  resetGpuDetectionCache();
  t.after(() => resetGpuDetectionCache());
  let config = targetConfig('host-a');
  let commandCalls = 0;
  const dependencies = {
    getConfig: () => config,
    getConnectionStatus: () => connectedStatus(config),
    executeCommand: async () => {
      commandCalls += 1;
      return {
        success: true,
        stdout: JSON.stringify([{ id: 0, name: `GPU-${config.host}`, vendor: 'Test' }]),
        stderr: ''
      };
    }
  };

  const hostAFirst = await detectGpus(false, dependencies);
  config = targetConfig('host-b');
  const hostB = await detectGpus(false, dependencies);
  config = targetConfig('host-a');
  const hostASecond = await detectGpus(false, dependencies);

  assert.equal(hostAFirst.primary.name, 'GPU-host-a');
  assert.equal(hostAFirst.target, 'root@host-a:22');
  assert.equal(hostB.primary.name, 'GPU-host-b');
  assert.equal(hostB.target, 'root@host-b:22');
  assert.equal(hostASecond.primary.name, 'GPU-host-a');
  assert.equal(commandCalls, 2);
  assert.notEqual(resolveGpuTargetIdentity(connectedStatus(config), config).label, hostB.target);
});

test('GPU discovery deduplicates concurrent scans for one target', async (t) => {
  resetGpuDetectionCache();
  t.after(() => resetGpuDetectionCache());
  const config = targetConfig('host-a');
  let commandCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dependencies = {
    getConfig: () => config,
    getConnectionStatus: () => connectedStatus(config),
    executeCommand: async () => {
      commandCalls += 1;
      await gate;
      return { success: true, stdout: '[]', stderr: '' };
    }
  };

  const first = detectGpus(false, dependencies);
  const second = detectGpus(false, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandCalls, 1);
  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
});

test('GPU discovery cache evicts least-recently-used targets at a fixed bound', async (t) => {
  resetGpuDetectionCache();
  t.after(() => resetGpuDetectionCache());
  let config = targetConfig('host-0');
  let commandCalls = 0;
  const dependencies = {
    getConfig: () => config,
    getConnectionStatus: () => connectedStatus(config),
    executeCommand: async () => {
      commandCalls += 1;
      return { success: true, stdout: '[]', stderr: '' };
    }
  };

  for (let index = 0; index <= GPU_CACHE_MAX_TARGETS; index += 1) {
    config = targetConfig(`host-${index}`);
    await detectGpus(false, dependencies);
  }
  assert.equal(commandCalls, GPU_CACHE_MAX_TARGETS + 1);

  config = targetConfig('host-0');
  await detectGpus(false, dependencies);
  assert.equal(commandCalls, GPU_CACHE_MAX_TARGETS + 2);
});

test('HF README route permits only a validated repo on the selected trusted origin', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response('# Safe model card', {
      status: 200,
      headers: { 'Content-Length': '17' }
    });
  };

  const response = fakeResponse();
  await llmRouteHandler('/hf/readme')(
    { query: { repo: 'owner/model', mirror: 'true' } },
    response
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.readme, '# Safe model card');
  assert.match(requestedUrl, /^https:\/\/hf-mirror\.com\/owner\/model\/raw\/main\/README\.md$/);

  const invalidResponse = fakeResponse();
  await llmRouteHandler('/hf/readme')(
    { query: { repo: 'https://evil.example/model' } },
    invalidResponse
  );
  assert.equal(invalidResponse.statusCode, 400);

  globalThis.fetch = async () => new Response('missing', { status: 404 });
  const missingResponse = fakeResponse();
  await llmRouteHandler('/hf/readme')(
    { query: { repo: 'owner/missing' } },
    missingResponse
  );
  assert.equal(missingResponse.statusCode, 502);
  assert.match(missingResponse.body.error, /上游状态 404/);
});

test('HF README reader enforces both declared and streamed one-megabyte limits', async () => {
  await assert.rejects(
    readBoundedResponseText(new Response('tiny', { headers: { 'Content-Length': '1048577' } })),
    (error) => error.code === 'HF_README_TOO_LARGE'
  );
  await assert.rejects(
    readBoundedResponseText(new Response(new Uint8Array(1024 * 1024 + 1))),
    (error) => error.code === 'HF_README_TOO_LARGE'
  );
});

test('HF search and file tree bound and normalize malformed upstream fields', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });

  globalThis.fetch = async () => new Response(JSON.stringify([
    null,
    {},
    { id: 42 },
    {
      id: ' owner/model-GGUF ',
      author: 42,
      downloads: -9,
      likes: Number.MAX_VALUE,
      lastModified: 123,
      pipeline_tag: [],
      tags: ['gguf', 7, '', 'safe-tag']
    }
  ]));
  const searchResponse = fakeResponse();
  await llmRouteHandler('/hf/search')({ query: {} }, searchResponse);
  assert.equal(searchResponse.statusCode, 200);
  assert.equal(searchResponse.body.data.length, 1);
  assert.deepEqual(searchResponse.body.data[0], {
    id: 'owner/model-GGUF',
    author: 'owner',
    name: 'model-GGUF',
    paramScale: '',
    downloads: 0,
    likes: Number.MAX_SAFE_INTEGER,
    lastModified: null,
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'safe-tag'],
    isGguf: true
  });

  globalThis.fetch = async () => new Response('[]', {
    headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) }
  });
  const oversizedSearchResponse = fakeResponse();
  await llmRouteHandler('/hf/search')({ query: {} }, oversizedSearchResponse);
  assert.equal(oversizedSearchResponse.statusCode, 413);

  globalThis.fetch = async () => new Response(JSON.stringify([
    null,
    { type: 'file', path: 42 },
    { type: 'directory', path: 'ignored.gguf' },
    { type: 'file', path: 'nested/model Q4_K_M.gguf', size: -5 }
  ]));
  const filesResponse = fakeResponse();
  await llmRouteHandler('/hf/model-files')(
    { query: { repo: 'owner/model' } },
    filesResponse
  );
  assert.equal(filesResponse.statusCode, 200);
  assert.equal(filesResponse.body.data.files.length, 1);
  assert.equal(filesResponse.body.data.files[0].sizeBytes, 0);
  assert.equal(
    filesResponse.body.data.files[0].downloadUrl,
    'https://huggingface.co/owner/model/resolve/main/nested/model%20Q4_K_M.gguf'
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ path: 'not-an-array' }));
  const malformedTreeResponse = fakeResponse();
  await llmRouteHandler('/hf/model-files')(
    { query: { repo: 'owner/model' } },
    malformedTreeResponse
  );
  assert.equal(malformedTreeResponse.statusCode, 502);
});

test('HF token endpoint persists or clears a bounded token without echoing it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-manager-hf-token-'));
  const previousConfigPath = process.env.CONFIG_FILE_PATH;
  process.env.CONFIG_FILE_PATH = path.join(directory, 'config.json');
  t.after(() => {
    if (previousConfigPath === undefined) delete process.env.CONFIG_FILE_PATH;
    else process.env.CONFIG_FILE_PATH = previousConfigPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const token = 'hf_abcdefghijklmnopqrstuvwxyz123456';
  assert.equal(validateHfAccessToken(`  ${token}  `), token);
  assert.throws(() => validateHfAccessToken('not-a-hf-token'), /格式无效/);
  assert.throws(() => validateHfAccessToken(`hf_${'a'.repeat(510)}`), /格式无效/);

  const saveResponse = fakeResponse();
  await llmRouteHandler('/hf/token', 'post')({ body: { token } }, saveResponse);
  assert.equal(saveResponse.statusCode, 200);
  assert.deepEqual(saveResponse.body, { success: true, hasHfToken: true });
  assert.equal(JSON.parse(fs.readFileSync(process.env.CONFIG_FILE_PATH, 'utf8')).hfToken, token);
  assert.equal(JSON.stringify(saveResponse.body).includes(token), false);

  const clearResponse = fakeResponse();
  await llmRouteHandler('/hf/token', 'post')({ body: { token: '   ' } }, clearResponse);
  assert.deepEqual(clearResponse.body, { success: true, hasHfToken: false });
  assert.equal(JSON.parse(fs.readFileSync(process.env.CONFIG_FILE_PATH, 'utf8')).hfToken, '');
});

test('LLM process discovery no longer adopts or broadly kills external llama processes', () => {
  const source = fs.readFileSync(path.join(here, '..', 'server', 'routes', 'llm.js'), 'utf8');
  assert.doesNotMatch(source, /ps aux \| grep llama-server/);
  assert.doesNotMatch(source, /pkill\s+-TERM\s+-f/);
  assert.doesNotMatch(source, /pkill\s+-KILL\s+-f/);
  assert.doesNotMatch(source, /\/tmp\/llama-server\.log/);
  assert.match(source, /executeCommand\('mktemp'[\s\S]*?llm-manager-\$\{kind\}\.XXXXXXXXXXXX/);
  assert.ok(source.includes('llama: /^\\/tmp\\/llm-manager-llama\\.'));
  assert.match(source, /Promise\.all\(\[[\s\S]*?\/v1\/models[\s\S]*?\/props[\s\S]*?\/slots/);
  assert.match(source, /activeTaskCount >= MAX_ACTIVE_MODEL_DOWNLOADS/);
  assert.match(source, /'--proto', '=https', '--proto-redir', '=https', '--max-redirs', '10'/);
  assert.match(source, /DOWNLOAD_LAUNCH_AMBIGUOUS/);
  assert.match(source, /safely stopped \$\{running\.length - 1\} older duplicate/);
  assert.match(source, /runCoalescedTargetScan\(modelState/);
  assert.match(source, /validateModelTargetDir\(targetDir \|\| getModelRoots\(\)\[0\]\)/);

  const chatBlock = source.slice(source.indexOf("router.post('/chat'"));
  assert.ok(chatBlock.indexOf('inspectManagedLlamaProcess') < chatBlock.indexOf('createForwardedConnection'));
  assert.match(chatBlock, /Cache-Control', 'no-store'/);

  for (const [routeStart, routeEnd] of [
    ["router.post('/run-local'", "router.post('/start'"],
    ["router.post('/start'", "router.post('/stop'"],
    ["router.post('/stop'", "router.post('/restart'"],
    ["router.post('/restart'", '// Get LLM Logs']
  ]) {
    const routeBlock = source.slice(source.indexOf(routeStart), source.indexOf(routeEnd));
    assert.match(routeBlock, /llmLifecycleMutex\.run\(target\.key/);
  }

  const sftpSource = fs.readFileSync(path.join(here, '..', 'server', 'sftpManager.js'), 'utf8');
  assert.match(sftpSource, /exclusive \? 'wx' : 'w'/);
  assert.match(source, /writeFile\(filePath, content, \{ mode: 0o600, exclusive: true \}\)/);
});
