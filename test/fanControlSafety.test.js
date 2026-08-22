import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAN_OPERATION_LOCK_FILE,
  FAN_RUNTIME_DIR,
  performFanServiceAction,
  recoverAutomaticFanControl
} from '../server/routes/fan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const daemonPath = path.join(projectRoot, 'linux', 'fan-control', 'fan-control.sh');
const installerPath = path.join(projectRoot, 'linux', 'fan-control', 'install.sh');
const servicePath = path.join(projectRoot, 'linux', 'fan-control', 'fan-control.service');
const fanRoutePath = path.join(projectRoot, 'server', 'routes', 'fan.js');

function queuedExecutor(responses, calls) {
  return async (executable, argv, options) => {
    calls.push({ executable, argv, options });
    const response = responses.shift();
    assert.ok(response, `Unexpected command: ${executable} ${argv.join(' ')}`);
    return response;
  };
}

test('Fan service actions are serialized and verified against the final systemd state', async () => {
  const calls = [];
  const result = await performFanServiceAction('restart', 'fan-control', queuedExecutor([
    { success: true, code: 0, stdout: 'FAN_SERVICE_STATE=active\nSTATUS:SUCCESS\n', stderr: '' }
  ], calls));

  assert.equal(result.success, true);
  assert.equal(result.state, 'active');
  assert.equal(calls.length, 1, 'action and verification must share one lock lifetime');
  assert.equal(calls[0].executable, 'sh');
  assert.equal(calls[0].argv[0], '-c');
  const script = calls[0].argv[1];
  assert.match(script, new RegExp(FAN_OPERATION_LOCK_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(script.indexOf('flock -x -w 10') < script.indexOf('systemctl restart fan-control'));
  assert.ok(script.indexOf('systemctl restart fan-control') < script.indexOf('systemctl is-active fan-control'));
});

test('Fan service actions reject command success when the requested state was not reached', async () => {
  const calls = [];
  const result = await performFanServiceAction('start', 'fan-control', queuedExecutor([
    { success: false, code: 71, stdout: 'FAN_SERVICE_STATE=failed\nSTATUS:STATE_MISMATCH\n', stderr: '' }
  ], calls));

  assert.equal(result.success, false);
  assert.equal(result.busy, false);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /预期为 active/);
});

test('Fan service stop accepts only a verified inactive state', async () => {
  const calls = [];
  const result = await performFanServiceAction('stop', 'fan-control', queuedExecutor([
    { success: true, code: 0, stdout: 'FAN_SERVICE_STATE=inactive\nSTATUS:SUCCESS\n', stderr: '' }
  ], calls));

  assert.equal(result.success, true);
  assert.equal(result.state, 'inactive');
});

test('Fan service action reports lock contention without claiming success or querying state', async () => {
  const calls = [];
  const result = await performFanServiceAction('restart', 'fan-control', queuedExecutor([
    { success: false, code: 75, stdout: '', stderr: '' }
  ], calls));

  assert.equal(result.success, false);
  assert.equal(result.busy, true);
  assert.equal(calls.length, 1);
});

test('Automatic recovery stops a failed new unit and falls back to the legacy controller', async () => {
  const calls = [];
  const result = await recoverAutomaticFanControl(queuedExecutor([
    { success: true, code: 0, stdout: 'FAN_RECOVERY_SERVICE=mi50-fan-control\nFAN_RECOVERY_STATE=active\nSTATUS:SUCCESS\n', stderr: '' }
  ], calls));

  assert.equal(result.success, true);
  assert.equal(result.serviceName, 'mi50-fan-control');
  assert.equal(calls.length, 1, 'the complete fallback must hold one operation lock');
  const script = calls[0].argv[1];
  assert.match(script, /for candidate in fan-control mi50-fan-control/);
  assert.ok(script.indexOf('flock -x -w 10') < script.indexOf('for candidate in fan-control mi50-fan-control'));
  assert.ok(script.indexOf('systemctl restart "$candidate"') < script.indexOf('systemctl stop "$candidate"'));
});

test('Automatic recovery never starts a fallback beside an already-active controller', async () => {
  const calls = [];
  const result = await recoverAutomaticFanControl(queuedExecutor([
    { success: true, code: 0, stdout: 'FAN_RECOVERY_SERVICE=fan-control\nFAN_RECOVERY_STATE=active\nSTATUS:SUCCESS\n', stderr: '' }
  ], calls));

  assert.equal(result.success, true);
  assert.equal(result.serviceName, 'fan-control');
  assert.equal(calls.length, 1);
  const script = calls[0].argv[1];
  assert.ok(script.indexOf('systemctl is-active --quiet "$candidate"') < script.indexOf('systemctl restart "$candidate"'));
});

test('Fan-control scripts contain shutdown restoration and transactional rollback contracts', async () => {
  const [daemon, installer, service, fanRoute] = await Promise.all([
    readFile(daemonPath, 'utf8'),
    readFile(installerPath, 'utf8'),
    readFile(servicePath, 'utf8'),
    readFile(fanRoutePath, 'utf8')
  ]);

  assert.match(daemon, /trap handle_exit EXIT/);
  assert.match(daemon, /trap 'exit 143' TERM/);
  assert.match(daemon, /restore_pwm_automatic/);
  assert.ok(daemon.indexOf("printf '255\\n'") < daemon.indexOf("printf '%s\\n' \"$automatic_value\""));
  assert.match(daemon, /--restore-auto/);
  assert.match(daemon, /flock -n 9/);
  assert.match(daemon, /directory_is_secure_for_locking/);
  assert.match(daemon, /configuration_file_is_secure/);
  assert.match(daemon, /load_configuration_file/);
  assert.match(daemon, /configuration_curve_is_safe/);
  assert.match(daemon, /\[ "\$g6" -eq 100 \]/);
  assert.match(daemon, /\[ "\$f6" -eq 100 \]/);
  assert.match(daemon, /if \[ "\$current_mode" = "\$automatic_value" \]/);
  assert.doesNotMatch(daemon, /^\s*\.\s+"\$CONFIG_FILE"/m);
  assert.match(daemon, /using built-in recovery defaults/);
  assert.match(daemon, /notify_ready/);
  assert.match(daemon, /systemd-notify --ready/);
  assert.match(daemon, /find_board_hwmons/);
  assert.match(daemon, /done < <\(find_hwmons "\$GPU_HWMON_NAMES"\)/);
  assert.ok(daemon.indexOf('flock -n 9') < daemon.lastIndexOf('if [ "${1:-}" = "--restore-auto" ]'));
  assert.ok(daemon.indexOf('startup recovery could not restore every configured automatic PWM mode') < daemon.indexOf('while true; do'));
  assert.match(service, /^ExecStopPost=.*fan-control\.sh --restore-auto$/m);
  assert.match(service, /^Type=notify$/m);
  assert.match(service, /^NotifyAccess=all$/m);
  assert.match(service, /^TimeoutStartSec=20s$/m);
  assert.match(service, /^TimeoutStopSec=15s$/m);
  assert.match(service, /^RestartPreventExitStatus=78$/m);
  assert.doesNotMatch(service, /^(?:After|Wants)=multi-user\.target$/m);

  assert.match(installer, /trap rollback EXIT/);
  assert.match(installer, /flock -x -w 30 -E 75 8/);
  assert.match(installer, /prepare_secure_lock_file/);
  assert.match(installer, /configuration_file_is_secure/);
  assert.match(installer, /wait_for_service_stability/);
  assert.match(installer, /bash -n "\$STAGE_DIR\/fan-control\.sh"/);
  assert.match(installer, /--validate-config/);
  assert.match(installer, /install -m 0644 "\$SOURCE_DIR\/fan-control\.conf" "\$STAGE_DIR\/fan-control\.conf"/);
  assert.match(installer, /CONFIG_VALIDATION_PATH="\$STAGE_DIR\/fan-control\.conf"/);
  assert.match(installer, /install -m 0644 "\$STAGE_DIR\/fan-control\.conf" "\$CONFIG_TEMP"/);
  assert.ok(installer.indexOf('--validate-config') < installer.indexOf('NEW_LOAD_STATE='));
  assert.match(installer, /did not remain active for the .* startup stability window/);
  assert.ok(installer.indexOf('if ! wait_for_service_stability "$NEW_SERVICE"') < installer.indexOf('"$SYSTEMCTL" disable "$LEGACY_SERVICE"'));
  assert.match(installer, /restore_service_state "\$LEGACY_SERVICE"/);
  assert.equal(FAN_RUNTIME_DIR, '/run/linux-llm-server-manager');
  assert.equal(FAN_OPERATION_LOCK_FILE, `${FAN_RUNTIME_DIR}/fan-control-operation.lock`);
  assert.match(fanRoute, /fan_directory_is_secure_for_locking/);
  assert.match(fanRoute, /recover_and_fail WRITE_FAILED_RECOVERY 74/);
  assert.equal((fanRoute.match(/systemctl stop "\$candidate"/g) || []).length, 3);
  assert.match(fanRoute, /STATUS:STOP_UNVERIFIED/);
  assert.equal((fanRoute.match(/inactive\|failed\|unknown/g) || []).length, 3);
  assert.doesNotMatch(fanRoute, /write_pwm[^\r\n]*\|\| exit 74/);
  for (const source of [daemon, installer, fanRoute]) {
    assert.doesNotMatch(source, /\/run\/lock\//);
  }
});

test('Linux fan-control deployment files use LF-only line endings', async () => {
  const paths = [
    daemonPath,
    installerPath,
    servicePath,
    path.join(projectRoot, 'linux', 'fan-control', 'fan-control.conf'),
    path.join(projectRoot, 'linux', 'fan-control', 'README.md')
  ];
  const contents = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
  for (let index = 0; index < contents.length; index += 1) {
    assert.equal(contents[index].includes('\r'), false, `${paths[index]} contains CRLF or bare CR bytes`);
  }
});

async function waitForFileValue(filePath, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, 'utf8')).trim() === expected) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain ${expected}`);
}

test('Fan-control entrypoints reject pre-positioned lock symlinks without truncating targets', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-lock-safety-'));
  const runtimeDir = path.join(tempDir, 'runtime');
  const installRoot = path.join(tempDir, 'root');
  const daemonVictim = path.join(tempDir, 'daemon-victim');
  const installerVictim = path.join(tempDir, 'installer-victim');
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all([
    writeFile(daemonVictim, 'daemon-sentinel\n'),
    writeFile(installerVictim, 'installer-sentinel\n'),
    symlink(daemonVictim, path.join(runtimeDir, 'daemon.lock')),
    symlink(installerVictim, path.join(runtimeDir, 'operation.lock'))
  ]);
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const commonEnv = {
    ...process.env,
    FAN_CONTROL_ALLOW_NON_ROOT_TESTING: '1'
  };
  const daemonResult = spawnSync('bash', [daemonPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...commonEnv,
      FAN_CONTROL_CONFIG: path.join(tempDir, 'missing.conf'),
      FAN_CONTROL_LOCK_FILE: path.join(runtimeDir, 'daemon.lock')
    }
  });
  assert.notEqual(daemonResult.status, 0);
  assert.match(`${daemonResult.stdout}\n${daemonResult.stderr}`, /refusing insecure daemon lock path/i);

  const installerResult = spawnSync('bash', [installerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...commonEnv,
      FAN_CONTROL_INSTALL_ROOT: installRoot,
      FAN_CONTROL_OPERATION_LOCK_FILE: path.join(runtimeDir, 'operation.lock')
    }
  });
  assert.notEqual(installerResult.status, 0);
  assert.match(installerResult.stderr, /refusing insecure fan-control operation lock path/i);
  assert.equal((await readFile(daemonVictim, 'utf8')).trim(), 'daemon-sentinel');
  assert.equal((await readFile(installerVictim, 'utf8')).trim(), 'installer-sentinel');
});

test('Fan-control entrypoints reject symlinked or writable configuration files', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-config-safety-'));
  const installRoot = path.join(tempDir, 'root');
  const invalidInstallRoot = path.join(tempDir, 'invalid-root');
  const installerConfig = path.join(installRoot, 'etc', 'default', 'fan-control');
  const invalidInstallerConfig = path.join(invalidInstallRoot, 'etc', 'default', 'fan-control');
  const daemonConfigLink = path.join(tempDir, 'daemon.conf');
  const writableConfig = path.join(tempDir, 'writable.conf');
  const invalidConfig = path.join(tempDir, 'invalid.conf');
  const configVictim = path.join(tempDir, 'config-victim');
  await Promise.all([
    mkdir(path.dirname(installerConfig), { recursive: true }),
    mkdir(path.dirname(invalidInstallerConfig), { recursive: true })
  ]);
  await Promise.all([
    writeFile(configVictim, 'INTERVAL=1\n'),
    writeFile(writableConfig, 'INTERVAL=1\n'),
    writeFile(invalidConfig, 'exit 99\n'),
    writeFile(invalidInstallerConfig, 'GPU_PCT_1=101\n')
  ]);
  await chmod(writableConfig, 0o666);
  await Promise.all([
    symlink(configVictim, daemonConfigLink),
    symlink(configVictim, installerConfig)
  ]);
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const commonEnv = {
    ...process.env,
    FAN_CONTROL_ALLOW_NON_ROOT_TESTING: '1'
  };
  const daemonLinkResult = spawnSync('bash', [daemonPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...commonEnv, FAN_CONTROL_CONFIG: daemonConfigLink }
  });
  assert.equal(daemonLinkResult.status, 78);
  assert.match(`${daemonLinkResult.stdout}\n${daemonLinkResult.stderr}`, /refusing insecure configuration file/i);

  const daemonModeResult = spawnSync('bash', [daemonPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...commonEnv, FAN_CONTROL_CONFIG: writableConfig }
  });
  assert.equal(daemonModeResult.status, 78);
  assert.match(`${daemonModeResult.stdout}\n${daemonModeResult.stderr}`, /refusing insecure configuration file/i);

  const restoreWithInvalidConfig = spawnSync('bash', [daemonPath, '--restore-auto'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...commonEnv,
      FAN_CONTROL_CONFIG: invalidConfig,
      FAN_CONTROL_HWMON_ROOT: path.join(tempDir, 'empty-hwmon'),
      FAN_CONTROL_LOCK_FILE: path.join(tempDir, 'restore-runtime', 'daemon.lock')
    }
  });
  assert.equal(restoreWithInvalidConfig.status, 0, `${restoreWithInvalidConfig.stdout}\n${restoreWithInvalidConfig.stderr}`);
  assert.match(`${restoreWithInvalidConfig.stdout}\n${restoreWithInvalidConfig.stderr}`, /using built-in recovery defaults/i);
  assert.match(`${restoreWithInvalidConfig.stdout}\n${restoreWithInvalidConfig.stderr}`, /No controllable PWM nodes/);

  const installerResult = spawnSync('bash', [installerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...commonEnv,
      FAN_CONTROL_INSTALL_ROOT: installRoot,
      FAN_CONTROL_OPERATION_LOCK_FILE: path.join(tempDir, 'runtime', 'operation.lock'),
      FAN_CONTROL_STARTUP_STABILITY_SECONDS: '1',
      TMPDIR: tempDir
    }
  });
  assert.equal(installerResult.status, 78);
  assert.match(installerResult.stderr, /refusing insecure existing configuration file/i);

  const invalidInstallerResult = spawnSync('bash', [installerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...commonEnv,
      FAN_CONTROL_INSTALL_ROOT: invalidInstallRoot,
      FAN_CONTROL_SYSTEMCTL: path.join(tempDir, 'must-not-run-systemctl'),
      FAN_CONTROL_OPERATION_LOCK_FILE: path.join(tempDir, 'invalid-runtime', 'operation.lock'),
      FAN_CONTROL_STARTUP_STABILITY_SECONDS: '1',
      TMPDIR: tempDir
    }
  });
  assert.equal(invalidInstallerResult.status, 78);
  assert.match(invalidInstallerResult.stderr, /invalid configuration syntax or unsupported key\/value/i);
  await assert.rejects(readFile(path.join(invalidInstallRoot, 'usr', 'local', 'sbin', 'fan-control.sh')));
  assert.equal((await readFile(configVictim, 'utf8')).trim(), 'INTERVAL=1');
});

test('Fan-control rejects non-monotonic or non-fail-safe curves before touching hardware', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-curve-safety-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const invalidCurves = [
    'TEMP_1=60\nTEMP_2=50\n',
    'GPU_PCT_5=90\nGPU_PCT_6=80\n',
    'FAN_PCT_6=99\n'
  ];
  for (let index = 0; index < invalidCurves.length; index += 1) {
    const configPath = path.join(tempDir, `invalid-${index}.conf`);
    await writeFile(configPath, invalidCurves[index]);
    const result = spawnSync('bash', [daemonPath, '--validate-config'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, FAN_CONTROL_CONFIG: configPath }
    });
    assert.equal(result.status, 78, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe curve/i);
  }
});

test('Fan daemon restores automatic modes and full-speed fallback after SIGTERM', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-daemon-safety-'));
  const hwmonRoot = path.join(tempDir, 'hwmon');
  const gpu = path.join(hwmonRoot, 'hwmon0');
  const board = path.join(hwmonRoot, 'hwmon1');
  const secondaryGpu = path.join(hwmonRoot, 'hwmon2');
  const secondaryBoard = path.join(hwmonRoot, 'hwmon3');
  const fallbackBoard = path.join(hwmonRoot, 'hwmon4');
  const notifyCommand = path.join(tempDir, 'systemd-notify');
  const notifyLog = path.join(tempDir, 'notify.log');
  await Promise.all([
    mkdir(gpu, { recursive: true }),
    mkdir(board, { recursive: true }),
    mkdir(secondaryGpu, { recursive: true }),
    mkdir(secondaryBoard, { recursive: true }),
    mkdir(fallbackBoard, { recursive: true })
  ]);

  const fixtures = new Map([
    [path.join(gpu, 'name'), 'amdgpu\n'],
    [path.join(gpu, 'temp2_label'), 'Junction\n'],
    [path.join(gpu, 'temp2_input'), '50000\n'],
    [path.join(gpu, 'temp3_label'), 'Memory\n'],
    [path.join(gpu, 'temp3_input'), '45000\n'],
    [path.join(gpu, 'pwm1'), '0\n'],
    [path.join(gpu, 'pwm1_enable'), '2\n'],
    [path.join(gpu, 'fan1_input'), '1200\n'],
    [path.join(board, 'name'), 'nct6776\n'],
    [path.join(board, 'pwm1'), '0\n'],
    [path.join(board, 'pwm1_enable'), '5\n'],
    [path.join(board, 'pwm2'), '0\n'],
    [path.join(board, 'pwm2_enable'), '5\n'],
    [path.join(board, 'pwm3'), '0\n'],
    [path.join(board, 'pwm3_enable'), '5\n'],
    [path.join(board, 'fan2_input'), '1400\n'],
    [path.join(secondaryGpu, 'name'), 'amdgpu\n'],
    [path.join(secondaryGpu, 'pwm1'), '0\n'],
    [path.join(secondaryGpu, 'pwm1_enable'), '2\n'],
    [path.join(secondaryBoard, 'name'), 'w83627ehf\n'],
    [path.join(secondaryBoard, 'pwm1'), '0\n'],
    [path.join(secondaryBoard, 'pwm1_enable'), '5\n'],
    [path.join(secondaryBoard, 'pwm2'), '0\n'],
    [path.join(secondaryBoard, 'pwm2_enable'), '5\n'],
    [path.join(secondaryBoard, 'pwm3'), '0\n'],
    [path.join(secondaryBoard, 'pwm3_enable'), '5\n'],
    [path.join(fallbackBoard, 'name'), 'pwm-fan\n'],
    [path.join(fallbackBoard, 'pwm1'), '0\n'],
    [path.join(fallbackBoard, 'pwm1_enable'), '5\n'],
    [path.join(fallbackBoard, 'pwm2'), '0\n'],
    [path.join(fallbackBoard, 'pwm2_enable'), '5\n']
  ]);
  await Promise.all([...fixtures].map(([file, content]) => writeFile(file, content)));
  await writeFile(notifyCommand, `#!/usr/bin/env bash
[ "\${1:-}" = "--ready" ] || exit 2
case "\${2:-}" in --status=*) ;; *) exit 2 ;; esac
printf 'ready\\n' > "$MOCK_NOTIFY_LOG"
`);
  await chmod(notifyCommand, 0o755);

  let output = '';
  const daemonEnv = {
    ...process.env,
    FAN_CONTROL_CONFIG: path.join(tempDir, 'missing.conf'),
    FAN_CONTROL_HWMON_ROOT: hwmonRoot,
    FAN_CONTROL_LOCK_FILE: path.join(tempDir, 'runtime', 'daemon.lock'),
    FAN_CONTROL_ALLOW_NON_ROOT_TESTING: '1',
    NOTIFY_SOCKET: '@fan-control-test',
    MOCK_NOTIFY_LOG: notifyLog,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH || ''}`,
    INTERVAL: '1'
  };
  const child = spawn('bash', [daemonPath], {
    cwd: projectRoot,
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exitPromise = once(child, 'exit');

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForFileValue(path.join(gpu, 'pwm1_enable'), '1');
  await waitForFileValue(path.join(board, 'pwm2_enable'), '1');
  await waitForFileValue(notifyLog, 'ready');
  assert.equal((await readFile(path.join(board, 'pwm1'), 'utf8')).trim(), '0');
  assert.equal((await readFile(path.join(board, 'pwm3'), 'utf8')).trim(), '0');
  assert.equal((await readFile(path.join(board, 'pwm1_enable'), 'utf8')).trim(), '5');
  assert.equal((await readFile(path.join(board, 'pwm3_enable'), 'utf8')).trim(), '5');
  assert.equal((await readFile(path.join(secondaryGpu, 'pwm1'), 'utf8')).trim(), '0');
  assert.equal((await readFile(path.join(secondaryGpu, 'pwm1_enable'), 'utf8')).trim(), '2');
  for (const index of [1, 2, 3]) {
    assert.equal((await readFile(path.join(secondaryBoard, `pwm${index}`), 'utf8')).trim(), '0');
    assert.equal((await readFile(path.join(secondaryBoard, `pwm${index}_enable`), 'utf8')).trim(), '5');
  }
  for (const index of [1, 2]) {
    assert.equal((await readFile(path.join(fallbackBoard, `pwm${index}`), 'utf8')).trim(), '0');
    assert.equal((await readFile(path.join(fallbackBoard, `pwm${index}_enable`), 'utf8')).trim(), '5');
  }

  await Promise.all([
    writeFile(path.join(board, 'pwm1'), '77\n'),
    writeFile(path.join(board, 'pwm1_enable'), '1\n')
  ]);
  const competingRestore = spawnSync('bash', [daemonPath, '--restore-auto'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: daemonEnv
  });
  assert.notEqual(competingRestore.status, 0);
  assert.match(`${competingRestore.stdout}\n${competingRestore.stderr}`, /already holds/);
  assert.equal((await readFile(path.join(board, 'pwm1'), 'utf8')).trim(), '77');
  assert.equal((await readFile(path.join(board, 'pwm1_enable'), 'utf8')).trim(), '1');

  child.kill('SIGTERM');
  const [code, signal] = await exitPromise;
  assert.equal(signal, null, output);
  assert.equal(code, 143, output);

  assert.equal((await readFile(path.join(gpu, 'pwm1'), 'utf8')).trim(), '255');
  assert.equal((await readFile(path.join(gpu, 'pwm1_enable'), 'utf8')).trim(), '2');
  assert.equal((await readFile(path.join(board, 'pwm1'), 'utf8')).trim(), '255');
  assert.equal((await readFile(path.join(board, 'pwm2'), 'utf8')).trim(), '255');
  assert.equal((await readFile(path.join(board, 'pwm3'), 'utf8')).trim(), '0');
  for (const index of [1, 2, 3]) {
    assert.equal((await readFile(path.join(board, `pwm${index}_enable`), 'utf8')).trim(), '5');
    assert.equal((await readFile(path.join(secondaryBoard, `pwm${index}`), 'utf8')).trim(), '0');
    assert.equal((await readFile(path.join(secondaryBoard, `pwm${index}_enable`), 'utf8')).trim(), '5');
  }
  for (const index of [1, 2]) {
    assert.equal((await readFile(path.join(fallbackBoard, `pwm${index}`), 'utf8')).trim(), '0');
    assert.equal((await readFile(path.join(fallbackBoard, `pwm${index}_enable`), 'utf8')).trim(), '5');
  }
  assert.equal((await readFile(path.join(secondaryGpu, 'pwm1'), 'utf8')).trim(), '0');
  assert.equal((await readFile(path.join(secondaryGpu, 'pwm1_enable'), 'utf8')).trim(), '2');
  assert.match(output, /Restored automatic fan control on 10 PWM controller\(s\)/);
});

test('Fan installer rolls back files and restores legacy service state when replacement fails its startup stability window', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-installer-rollback-'));
  const installRoot = path.join(tempDir, 'root');
  const stateDir = path.join(tempDir, 'state');
  const mockSystemctl = path.join(tempDir, 'systemctl');
  await Promise.all([mkdir(installRoot, { recursive: true }), mkdir(stateDir, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(stateDir, 'legacy.enabled'), 'enabled\n'),
    writeFile(path.join(stateDir, 'legacy.active'), 'active\n'),
    writeFile(path.join(stateDir, 'new.enabled'), 'disabled\n'),
    writeFile(path.join(stateDir, 'new.active'), 'inactive\n')
  ]);

  const mock = `#!/usr/bin/env bash
set -eu
state_dir="$MOCK_STATE_DIR"
root="$FAN_CONTROL_INSTALL_ROOT"
while [ "\${1:-}" = "--no-pager" ] || [ "\${1:-}" = "--full" ]; do shift; done
command="\${1:-}"; [ "$#" -eq 0 ] || shift
service="\${1:-}"
key=new
[ "$service" = "mi50-fan-control.service" ] && key=legacy
case "$command" in
  show)
    if [ "$key" = legacy ] || [ -e "$root/etc/systemd/system/fan-control.service" ]; then
      printf 'loaded\\n'
    else
      printf 'not-found\\n'
    fi
    ;;
  is-enabled)
    [ "\${1:-}" = "--quiet" ] && shift
    service="\${1:-}"; key=new; [ "$service" = "mi50-fan-control.service" ] && key=legacy
    [ "$(cat "$state_dir/$key.enabled")" = enabled ]
    ;;
  is-active)
    [ "\${1:-}" = "--quiet" ] && shift
    service="\${1:-}"; key=new; [ "$service" = "mi50-fan-control.service" ] && key=legacy
    value="$(cat "$state_dir/$key.active")"
    if [ "$key" = new ] && [ "\${MOCK_FAIL_NEW_DURING_STABILITY:-0}" = 1 ] && [ "$value" = active ]; then
      count_file="$state_dir/new.active-checks"
      count=0
      [ ! -e "$count_file" ] || count="$(cat "$count_file")"
      count=$((count + 1))
      printf '%s\\n' "$count" > "$count_file"
      if [ "$count" -ge 2 ]; then
        value=failed
        printf 'failed\\n' > "$state_dir/new.active"
      fi
    fi
    [ "\${MOCK_QUIET:-0}" = 1 ] || printf '%s\\n' "$value"
    [ "$value" = active ]
    ;;
  daemon-reload|status) exit 0 ;;
  enable) printf 'enabled\\n' > "$state_dir/$key.enabled" ;;
  disable) printf 'disabled\\n' > "$state_dir/$key.enabled" ;;
  stop) printf 'inactive\\n' > "$state_dir/$key.active" ;;
  start)
    printf 'active\\n' > "$state_dir/$key.active"
    ;;
  restart)
    printf 'active\\n' > "$state_dir/$key.active"
    ;;
  *) echo "unexpected systemctl command: $command $service" >&2; exit 2 ;;
esac
`;
  await writeFile(mockSystemctl, mock);
  await chmod(mockSystemctl, 0o755);

  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const result = spawnSync('bash', [installerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAN_CONTROL_INSTALL_ROOT: installRoot,
      FAN_CONTROL_SYSTEMCTL: mockSystemctl,
      FAN_CONTROL_OPERATION_LOCK_FILE: path.join(tempDir, 'runtime', 'operation.lock'),
      FAN_CONTROL_ALLOW_NON_ROOT_TESTING: '1',
      FAN_CONTROL_STARTUP_STABILITY_SECONDS: '1',
      MOCK_STATE_DIR: stateDir,
      MOCK_FAIL_NEW_DURING_STABILITY: '1',
      TMPDIR: tempDir
    }
  });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /startup stability window/);
  assert.match(result.stderr, /rolling back files and service state/);
  await assert.rejects(readFile(path.join(installRoot, 'usr', 'local', 'sbin', 'fan-control.sh')));
  await assert.rejects(readFile(path.join(installRoot, 'etc', 'systemd', 'system', 'fan-control.service')));
  await assert.rejects(readFile(path.join(installRoot, 'etc', 'default', 'fan-control')));
  assert.equal((await readFile(path.join(stateDir, 'legacy.enabled'), 'utf8')).trim(), 'enabled');
  assert.equal((await readFile(path.join(stateDir, 'legacy.active'), 'utf8')).trim(), 'active');
  assert.equal((await readFile(path.join(stateDir, 'new.enabled'), 'utf8')).trim(), 'disabled');
  assert.equal((await readFile(path.join(stateDir, 'new.active'), 'utf8')).trim(), 'inactive');
});

test('Fan installer installs the validated staged default configuration even if its source changes later', {
  skip: process.platform !== 'linux',
  timeout: 12_000
}, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fan-installer-stage-'));
  const sourceDir = path.join(tempDir, 'source');
  const installRoot = path.join(tempDir, 'root');
  const stateDir = path.join(tempDir, 'state');
  const mockSystemctl = path.join(tempDir, 'systemctl');
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true })
  ]);
  await Promise.all([
    copyFile(daemonPath, path.join(sourceDir, 'fan-control.sh')),
    copyFile(installerPath, path.join(sourceDir, 'install.sh')),
    copyFile(servicePath, path.join(sourceDir, 'fan-control.service')),
    copyFile(path.join(projectRoot, 'linux', 'fan-control', 'fan-control.conf'), path.join(sourceDir, 'fan-control.conf'))
  ]);
  const expectedConfig = await readFile(path.join(sourceDir, 'fan-control.conf'), 'utf8');

  await writeFile(mockSystemctl, `#!/usr/bin/env bash
set -eu
while [ "\${1:-}" = "--no-pager" ] || [ "\${1:-}" = "--full" ]; do shift; done
command="\${1:-}"; [ "$#" -eq 0 ] || shift
if [ "\${1:-}" = "--quiet" ]; then shift; fi
service="\${1:-}"
case "$command" in
  show)
    if [ "$service" = "fan-control.service" ] && [ ! -e "$MOCK_STATE_DIR/source-mutated" ]; then
      printf 'GPU_PCT_6=0\\n' > "$MOCK_SOURCE_CONFIG"
      : > "$MOCK_STATE_DIR/source-mutated"
    fi
    printf 'not-found\\n'
    ;;
  daemon-reload|status) exit 0 ;;
  enable) printf 'enabled\\n' > "$MOCK_STATE_DIR/new.enabled" ;;
  restart|start) printf 'active\\n' > "$MOCK_STATE_DIR/new.active" ;;
  stop) printf 'inactive\\n' > "$MOCK_STATE_DIR/new.active" ;;
  disable) printf 'disabled\\n' > "$MOCK_STATE_DIR/new.enabled" ;;
  is-active) [ "$(cat "$MOCK_STATE_DIR/new.active" 2>/dev/null || printf inactive)" = active ] ;;
  is-enabled) [ "$(cat "$MOCK_STATE_DIR/new.enabled" 2>/dev/null || printf disabled)" = enabled ] ;;
  *) echo "unexpected systemctl command: $command $service" >&2; exit 2 ;;
esac
`);
  await chmod(mockSystemctl, 0o755);
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const result = spawnSync('bash', [path.join(sourceDir, 'install.sh')], {
    cwd: sourceDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAN_CONTROL_INSTALL_ROOT: installRoot,
      FAN_CONTROL_SYSTEMCTL: mockSystemctl,
      FAN_CONTROL_OPERATION_LOCK_FILE: path.join(tempDir, 'runtime', 'operation.lock'),
      FAN_CONTROL_ALLOW_NON_ROOT_TESTING: '1',
      FAN_CONTROL_STARTUP_STABILITY_SECONDS: '1',
      MOCK_SOURCE_CONFIG: path.join(sourceDir, 'fan-control.conf'),
      MOCK_STATE_DIR: stateDir,
      TMPDIR: tempDir
    }
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(path.join(installRoot, 'etc', 'default', 'fan-control'), 'utf8'), expectedConfig);
  assert.equal(await readFile(path.join(sourceDir, 'fan-control.conf'), 'utf8'), 'GPU_PCT_6=0\n');
});
