import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSshTargetContext,
  captureSshTargetContext,
  disconnect,
  runWithSshTargetContext
} from '../server/sshManager.js';

test('SSH target contexts invalidate queued work after a server switch', async () => {
  const originalContext = captureSshTargetContext();
  await runWithSshTargetContext(originalContext, async () => {
    assert.equal(assertSshTargetContext(), true);
    disconnect();
    assert.throws(
      () => assertSshTargetContext(),
      (error) => error.code === 'SSH_TARGET_CHANGED'
    );
  });
});
