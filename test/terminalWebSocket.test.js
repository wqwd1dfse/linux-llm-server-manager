import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleTerminalWebSocket } from '../server/ws/terminal.js';

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload, callback) {
    this.sent.push(JSON.parse(payload));
    callback?.();
  }

  close() {
    this.readyState = 3;
  }
}

class FakeShell extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.endCalls = 0;
    this.destroyCalls = 0;
  }

  write() { return true; }
  end() { this.endCalls += 1; }
  destroy() { this.destroyCalls += 1; }
  setWindow() {}
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Terminal WebSocket coalesces concurrent init messages into one SSH shell', async () => {
  const ws = new FakeWebSocket();
  const shell = new FakeShell();
  let createCalls = 0;
  handleTerminalWebSocket(ws, null, {
    createShellFn: async () => {
      createCalls += 1;
      await flush();
      return shell;
    }
  });

  const init = Buffer.from(JSON.stringify({ type: 'init', cols: 80, rows: 24 }));
  ws.emit('message', init);
  ws.emit('message', init);
  await flush();
  await flush();

  assert.equal(createCalls, 1);
  assert.equal(ws.sent.filter((message) => message.type === 'ready').length, 1);
});

test('Terminal WebSocket destroys a shell that resolves after the browser disconnects', async () => {
  const ws = new FakeWebSocket();
  const shell = new FakeShell();
  let resolveShell;
  handleTerminalWebSocket(ws, null, {
    createShellFn: () => new Promise((resolve) => { resolveShell = resolve; })
  });

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'init' })));
  await flush();
  ws.emit('close');
  resolveShell(shell);
  await flush();

  assert.equal(shell.endCalls, 1);
  assert.equal(shell.destroyCalls, 1);
  assert.equal(ws.sent.length, 0);
});
