import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import {
  movePathToTrash,
  pipeSftpFileToResponse,
  restoreTrashItemPath
} from '../server/routes/files.js';

function createResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      response.headersSent = true;
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  response.headersSent = false;
  response.body = () => Buffer.concat(chunks).toString('utf8');
  return response;
}

test('Remote file streaming tears down the SFTP stream when the client aborts', async () => {
  const request = new EventEmitter();
  const response = createResponse();
  const remoteStream = new PassThrough();
  const transfer = pipeSftpFileToResponse(
    request,
    response,
    { createReadStream: () => remoteStream },
    '/remote/large.bin'
  );

  remoteStream.write('partial');
  request.emit('aborted');

  await assert.rejects(transfer, (error) => error.code === 'CLIENT_ABORTED');
  assert.equal(remoteStream.destroyed, true);
});

test('Remote file streaming completes normally without treating close as an abort', async () => {
  const request = new EventEmitter();
  const response = createResponse();
  const remoteStream = new PassThrough();
  const transfer = pipeSftpFileToResponse(
    request,
    response,
    { createReadStream: () => remoteStream },
    '/remote/small.txt'
  );

  remoteStream.end('complete');
  await transfer;
  assert.equal(response.body(), 'complete');
});

test('Remote file streaming terminates a started HTTP response on upstream error', async () => {
  const request = new EventEmitter();
  const response = createResponse();
  const remoteStream = new PassThrough();
  const transfer = pipeSftpFileToResponse(
    request,
    response,
    { createReadStream: () => remoteStream },
    '/remote/interrupted.bin'
  );

  remoteStream.write('partial');
  remoteStream.destroy(new Error('upstream failed'));

  await assert.rejects(transfer, /upstream failed/);
  assert.equal(response.headersSent, true);
  assert.equal(response.destroyed, true);
});

test('Remote file streaming rejects close-before-end and terminates a partial response', async () => {
  const request = new EventEmitter();
  const response = createResponse();
  const remoteStream = new PassThrough();
  const transfer = pipeSftpFileToResponse(
    request,
    response,
    { createReadStream: () => remoteStream },
    '/remote/truncated.bin'
  );

  remoteStream.write('partial');
  remoteStream.destroy();

  await assert.rejects(transfer, (error) => error.code === 'SFTP_STREAM_CLOSED');
  assert.equal(response.destroyed, true);
});

test('Trash metadata is durable before an ambiguous move result', async () => {
  const events = [];
  const remoteState = { original: true, metadata: false, item: false };
  const targetChanged = new Error('Target server changed while the remote operation was pending');
  targetChanged.code = 'SSH_TARGET_CHANGED';

  await assert.rejects(
    movePathToTrash('/data/model.gguf', {
      getTrashDirFn: async () => '/home/manager/.server-manager-trash',
      nowFn: () => 1_700_000_000_000,
      randomBytesFn: () => Buffer.from('deadbeef', 'hex'),
      writeFileFn: async (remotePath, content, options) => {
        events.push('metadata');
        assert.equal(remoteState.original, true);
        assert.match(remotePath, /1700000000000-deadbeef\.meta\.json$/);
        assert.equal(JSON.parse(content).originalPath, '/data/model.gguf');
        assert.deepEqual(options, { mode: 0o600, exclusive: true });
        remoteState.metadata = true;
      },
      executeCommandFn: async (executable) => {
        if (executable === 'test') {
          events.push('directory-check');
          return { success: false, stdout: '', stderr: '' };
        }
        assert.equal(executable, 'mv');
        events.push('move');
        assert.equal(remoteState.metadata, true);
        remoteState.original = false;
        remoteState.item = true;
        throw targetChanged;
      }
    }),
    (error) => error.code === 'SSH_TARGET_CHANGED'
  );

  assert.deepEqual(events, ['directory-check', 'metadata', 'move']);
  assert.deepEqual(remoteState, { original: false, metadata: true, item: true });
  assert.equal(remoteState.item && !remoteState.metadata, false);
});

test('Trash restore never clobbers a target created during the move race', async () => {
  const calls = [];
  let existenceChecks = 0;
  const result = await restoreTrashItemPath(
    '/home/manager/.server-manager-trash/1700000000000-deadbeef.item',
    '/mnt/models/model.gguf',
    async (executable, argv) => {
      calls.push([executable, argv]);
      if (executable === 'sh') {
        existenceChecks += 1;
        const exists = existenceChecks === 2;
        return { success: exists, code: exists ? 0 : 1, stdout: '', stderr: '' };
      }
      return { success: true, code: 0, stdout: '', stderr: '' };
    }
  );

  assert.deepEqual(result, { restored: false, conflict: true });
  const moveCall = calls.find(([executable]) => executable === 'mv');
  assert.deepEqual(moveCall[1].slice(0, 2), ['--no-clobber', '--no-target-directory']);
  assert.equal(calls.filter(([executable]) => executable === 'mv').length, 1);
});

test('Trash restore preserves metadata when post-move existence is indeterminate', async () => {
  let existenceChecks = 0;
  await assert.rejects(
    restoreTrashItemPath('/trash/item', '/mnt/models/model.gguf', async (executable) => {
      if (executable === 'sh') {
        existenceChecks += 1;
        if (existenceChecks === 1) return { success: false, code: 1, stdout: '', stderr: '' };
        return { success: false, code: -1, timeout: true, stdout: '', stderr: 'timed out' };
      }
      return { success: true, code: 0, stdout: '', stderr: '' };
    }),
    (error) => error.code === 'REMOTE_PATH_CHECK_TIMEOUT'
  );
});
