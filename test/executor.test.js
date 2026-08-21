import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteArg,
  buildSafeCommand,
  validateSystemdAction,
  validateServiceName,
  validateDockerAction,
  validateDockerIdentifier,
  validatePid,
  validateSignal,
  validatePort,
  validateSafePath,
  validatePathWithinRoots
} from '../server/executor.js';

test('Executor: POSIX argument quoting', () => {
  assert.equal(quoteArg('hello'), 'hello');
  assert.equal(quoteArg('hello world'), "'hello world'");
  assert.equal(quoteArg("it's"), "'it'\\''s'");
  assert.equal(quoteArg('; rm -rf / ;'), "'; rm -rf / ;'");
  assert.equal(quoteArg('$PATH $(whoami) `id`'), "'$PATH $(whoami) `id`'");
});

test('Executor: Safe command builder with array args', () => {
  const cmd = buildSafeCommand('systemctl', ['restart', 'nginx']);
  assert.equal(cmd, 'systemctl restart nginx');

  const evilCmd = buildSafeCommand('docker', ['stop', 'container1; reboot']);
  assert.equal(evilCmd, "docker stop 'container1; reboot'");
});

test('Executor: Systemd action whitelist validation', () => {
  assert.equal(validateSystemdAction('start'), 'start');
  assert.equal(validateSystemdAction('stop'), 'stop');
  assert.equal(validateSystemdAction('restart'), 'restart');
  assert.equal(validateSystemdAction('status'), 'status');
  assert.equal(validateSystemdAction('reload'), 'reload');

  assert.throws(() => validateSystemdAction('reboot'), /非法 Systemd 指令/);
  assert.throws(() => validateSystemdAction('start; rm -rf /'), /非法 Systemd 指令/);
});

test('Executor: Service name validation', () => {
  assert.equal(validateServiceName('nginx'), 'nginx.service');
  assert.equal(validateServiceName('fan-control.service'), 'fan-control.service');
  assert.equal(validateServiceName('docker@1'), 'docker@1.service');

  assert.throws(() => validateServiceName('nginx; reboot'), /非法服务名称/);
  assert.throws(() => validateServiceName('service | cat /etc/shadow'), /非法服务名称/);
});

test('Executor: Docker action and identifier validation', () => {
  assert.equal(validateDockerAction('start'), 'start');
  assert.equal(validateDockerAction('rm'), 'rm');
  assert.throws(() => validateDockerAction('exec'), /非法 Docker 操作/);

  assert.equal(validateDockerIdentifier('my-nginx_1'), 'my-nginx_1');
  assert.equal(validateDockerIdentifier('registry.hub.docker.com/library/ubuntu:22.04'), 'registry.hub.docker.com/library/ubuntu:22.04');
  assert.throws(() => validateDockerIdentifier('ubuntu & touch /tmp/pwned'), /非法 Docker 标识符/);
});

test('Executor: PID, Signal and Port validations', () => {
  assert.equal(validatePid('1234'), 1234);
  assert.equal(validatePid(456), 456);
  assert.throws(() => validatePid('-1'), /非法进程 PID/);
  assert.throws(() => validatePid('123; reboot'), /非法进程 PID/);

  assert.equal(validateSignal('9'), '9');
  assert.equal(validateSignal('TERM'), 'TERM');
  assert.throws(() => validateSignal('9; whoami'), /非法信号/);

  assert.equal(validatePort(8080), 8080);
  assert.equal(validatePort('3888'), 3888);
  assert.throws(() => validatePort(0), /非法端口号/);
  assert.throws(() => validatePort(70000), /非法端口号/);
});

test('Executor: Safe path traversal validation', () => {
  assert.equal(validateSafePath('/root/data/file.txt'), '/root/data/file.txt');
  assert.equal(validateSafePath('/opt/models/gpt.gguf'), '/opt/models/gpt.gguf');
  assert.equal(validateSafePath('/'), '/');
  assert.equal(validateSafePath('/root/data/../data/file.txt'), '/root/data/file.txt');

  assert.throws(() => validateSafePath('relative/path'), /必须为绝对路径/);
  assert.throws(() => validateSafePath('/tmp/evil\0file'), /包含非法空字符/);
});


test('Executor: root containment rejects prefix-boundary bypasses', () => {
  assert.deepEqual(
    validatePathWithinRoots('/mnt/models/model.gguf', ['/mnt/models']),
    { path: '/mnt/models/model.gguf', root: '/mnt/models' }
  );
  assert.deepEqual(
    validatePathWithinRoots('/mnt/models', ['/mnt/models']),
    { path: '/mnt/models', root: '/mnt/models' }
  );
  assert.throws(
    () => validatePathWithinRoots('/mnt/models-backup/model.gguf', ['/mnt/models']),
    /允许的根目录/
  );
  assert.throws(
    () => validatePathWithinRoots('/opt/other/model.gguf', ['/mnt/models', '/opt/models']),
    /允许的根目录/
  );
});
