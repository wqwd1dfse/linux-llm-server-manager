import test from 'node:test';
import assert from 'node:assert/strict';

import { attachConnectedSocketToAgent } from '../server/routes/llm.js';

test('LLM SSH proxy attaches an already-connected channel asynchronously', async () => {
  const agent = {};
  const socket = { destroyed: false };
  attachConnectedSocketToAgent(agent, socket);

  let synchronous = true;
  let received = null;
  agent.createConnection({}, (error, connectedSocket) => {
    assert.equal(synchronous, false);
    received = { error, connectedSocket };
  });
  synchronous = false;

  assert.equal(received, null);
  await Promise.resolve();
  assert.equal(received.error, null);
  assert.equal(received.connectedSocket, socket);
});

test('LLM SSH proxy reports a channel that closed before agent attachment', async () => {
  const agent = {};
  attachConnectedSocketToAgent(agent, { destroyed: true });

  const result = await new Promise((resolve) => {
    agent.createConnection({}, (error, socket) => resolve({ error, socket }));
  });

  assert.match(result.error.message, /端口转发连接已关闭/);
  assert.equal(result.socket, undefined);
});
