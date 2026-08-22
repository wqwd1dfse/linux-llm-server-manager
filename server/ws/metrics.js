import { metricsCollector } from '../metricsCollector.js';
import { getConnectionStatus, getSshTargetEpoch, onSshTargetEpochChanged } from '../sshManager.js';

const metricsClients = new Set();
const MAX_BUFFERED_METRICS_BYTES = 512 * 1024;

function broadcast(payload) {
  const encoded = JSON.stringify(payload);
  for (const client of metricsClients) sendJson(client, encoded);
}

onSshTargetEpochChanged((event) => {
  broadcast({
    type: 'target',
    targetEpoch: event.targetEpoch,
    reason: event.reason,
    connected: getConnectionStatus().connected
  });
});

function removeSlowClient(client) {
  metricsClients.delete(client);
  try { client.close(1013, 'Metrics client is too slow'); } catch (_) {}
  try { client.terminate?.(); } catch (_) {}
}

function sendJson(client, payload) {
  if (client.readyState !== 1) return false;
  if (client.bufferedAmount > MAX_BUFFERED_METRICS_BYTES) {
    removeSlowClient(client);
    return false;
  }
  try {
    client.send(payload, (error) => {
      if (error) removeSlowClient(client);
    });
    return true;
  } catch (_) {
    removeSlowClient(client);
    return false;
  }
}

// Hook listener to centralized metricsCollector
metricsCollector.addListener((snapshot) => {
  if (metricsClients.size === 0) return;

  const payload = snapshot
    ? JSON.stringify({ type: 'metrics', connected: true, targetEpoch: getSshTargetEpoch(), data: snapshot })
    : JSON.stringify({ type: 'status', connected: false, targetEpoch: getSshTargetEpoch(), message: '远程服务器未连接' });

  for (const client of metricsClients) {
    sendJson(client, payload);
  }
});

export function handleMetricsWebSocket(ws) {
  metricsClients.add(ws);

  // Send current cached snapshot immediately
  sendImmediateSnapshot(ws);

  // Ensure collector is running
  metricsCollector.start();

  ws.on('close', () => {
    metricsClients.delete(ws);
  });

  ws.on('error', () => {
    metricsClients.delete(ws);
  });
}

function sendImmediateSnapshot(ws) {
  if (ws.readyState !== 1) return;

  const status = getConnectionStatus();
  if (!status.connected) {
    sendJson(ws, JSON.stringify({
      type: 'status',
      connected: false,
      targetEpoch: status.targetEpoch,
      message: '远程服务器未连接'
    }));
    return;
  }

  const cached = metricsCollector.getSnapshot();
  if (cached) {
    sendJson(ws, JSON.stringify({
      type: 'metrics',
      connected: true,
      targetEpoch: status.targetEpoch,
      data: cached
    }));
  } else {
    // Trigger an immediate collection. Its centralized listener broadcasts
    // the resulting snapshot to every client, including this one; sending it
    // again from this promise would duplicate the first metrics frame.
    metricsCollector.collect()
      .catch((err) => {
        if (ws.readyState === 1) {
          sendJson(ws, JSON.stringify({
            type: 'error',
            connected: false,
            targetEpoch: getSshTargetEpoch(),
            error: err.message
          }));
        }
      });
  }
}
