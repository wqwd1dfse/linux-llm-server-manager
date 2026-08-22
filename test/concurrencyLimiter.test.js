import test from 'node:test';
import assert from 'node:assert/strict';

import { ConcurrencyLimiter } from '../server/concurrencyLimiter.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('ConcurrencyLimiter holds excess work and releases it in order', async () => {
  const limiter = new ConcurrencyLimiter(1, 2, 1000);
  const firstGate = deferred();
  const events = [];
  const first = limiter.run(async () => {
    events.push('first-start');
    await firstGate.promise;
    events.push('first-end');
  });
  const second = limiter.run(async () => { events.push('second'); });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  assert.equal(limiter.activeCount, 1);
  assert.equal(limiter.pendingCount, 1);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  assert.equal(limiter.activeCount, 0);
});

test('ConcurrencyLimiter rejects queue overflow and queued aborts without leaking slots', async () => {
  const limiter = new ConcurrencyLimiter(1, 1, 1000);
  const gate = deferred();
  const first = limiter.run(() => gate.promise);
  const controller = new AbortController();
  const queued = limiter.run(async () => 'never', { signal: controller.signal });

  await assert.rejects(
    limiter.run(async () => 'overflow'),
    (error) => error.code === 'QUEUE_FULL'
  );
  controller.abort();
  await assert.rejects(queued, (error) => error.code === 'ABORT_ERR');
  assert.equal(limiter.pendingCount, 0);

  gate.resolve();
  await first;
  assert.equal(limiter.activeCount, 0);
});
