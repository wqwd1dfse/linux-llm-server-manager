import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  buildSftpWriteOptions,
  createSftpChannelLimiter,
  readFileWithSftp,
  runWithSftpChannelLimit,
  writeFileWithSftp
} from '../server/sftpManager.js';

function fakeSftp(stream, reportedSize) {
  return {
    stat: (_path, callback) => callback(null, { size: reportedSize }),
    createReadStream: () => stream
  };
}

test('SFTP buffered reads enforce the byte limit while data is streaming', async () => {
  const stream = new PassThrough();
  const reading = readFileWithSftp(fakeSftp(stream, 2), '/remote/growing.txt', 4);
  stream.write(Buffer.from('abc'));
  stream.write(Buffer.from('def'));

  await assert.rejects(reading, /4B 上限/);
  assert.equal(stream.destroyed, true);
});

test('SFTP buffered reads return the actual bytes received', async () => {
  const stream = new PassThrough();
  const reading = readFileWithSftp(fakeSftp(stream, 3), '/remote/file.txt', 1024);
  stream.end('hello');

  const result = await reading;
  assert.equal(result.size, 5);
  assert.equal(result.content, 'hello');
});

test('SFTP buffered reads reject close-before-end and release their limiter slot', async () => {
  const stream = new PassThrough();
  const limiter = createSftpChannelLimiter({
    MAX_CONCURRENT_SFTP_CHANNELS: '1',
    MAX_QUEUED_SFTP_OPERATIONS: '0',
    SFTP_QUEUE_TIMEOUT_MS: '1000'
  });
  const reading = runWithSftpChannelLimit(
    () => readFileWithSftp(fakeSftp(stream, 1), '/remote/truncated.txt', 1024),
    {},
    limiter
  );

  stream.destroy();

  await assert.rejects(reading, (error) => error.code === 'SFTP_STREAM_CLOSED');
  assert.equal(limiter.activeCount, 0);
  assert.equal(await runWithSftpChannelLimit(async () => 'released', {}, limiter), 'released');
});

test('SFTP private writes request exclusive creation with the requested mode', () => {
  assert.deepEqual(buildSftpWriteOptions({ mode: 0o600, exclusive: true }), {
    flags: 'wx',
    mode: 0o600
  });
  assert.deepEqual(buildSftpWriteOptions(), { flags: 'w' });
  assert.throws(() => buildSftpWriteOptions({ mode: '999' }), /非法文件权限模式/);
});

test('SFTP writes reject close-before-finish instead of hanging', async () => {
  const stream = new EventEmitter();
  stream.write = () => true;
  stream.end = () => {};
  stream.destroy = () => {};
  const writing = writeFileWithSftp(
    { createWriteStream: () => stream },
    '/remote/truncated.txt',
    'payload'
  );

  stream.emit('close');

  await assert.rejects(writing, (error) => error.code === 'SFTP_STREAM_CLOSED');
});

test('SFTP channel limiter bounds active work and releases queued operations', async () => {
  const limiter = createSftpChannelLimiter({
    MAX_CONCURRENT_SFTP_CHANNELS: '1',
    MAX_QUEUED_SFTP_OPERATIONS: '1',
    SFTP_QUEUE_TIMEOUT_MS: '1000'
  });
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const events = [];
  const first = runWithSftpChannelLimit(async () => {
    events.push('first');
    await gate;
  }, {}, limiter);
  const second = runWithSftpChannelLimit(async () => {
    events.push('second');
  }, {}, limiter);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  assert.equal(limiter.activeCount, 1);
  assert.equal(limiter.pendingCount, 1);
  await assert.rejects(
    runWithSftpChannelLimit(async () => 'overflow', {}, limiter),
    (error) => error.code === 'QUEUE_FULL'
  );

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(limiter.activeCount, 0);
});
