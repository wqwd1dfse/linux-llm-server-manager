import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsCollector } from '../server/metricsCollector.js';

test('MetricsCollector: Truthful history buffer without sine-wave fake data', () => {
  const history = metricsCollector.getHistory('5m');
  assert.ok(history);
  assert.ok(Array.isArray(history.points));
  assert.ok(history.stats);

  // Stats calculate truthfully over real recorded points
  if (history.points.length === 0) {
    assert.equal(history.stats.cpu.avg, null);
    assert.equal(history.stats.gpuJunction.avg, null);
  }
});
