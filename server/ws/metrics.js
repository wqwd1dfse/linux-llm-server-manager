import { metricsCollector } from '../metricsCollector.js';
import { getConnectionStatus } from '../sshManager.js';

const metricsClients = new Set();

// Hook listener to centralized metricsCollector
metricsCollector.addListener((snapshot) => {
  if (metricsClients.size === 0) return;

  const payload = JSON.stringify({
    type: 'metrics',
    connected: true,
    data: snapshot
  });

  for (const client of metricsClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(payload);
      } catch (_) {}
    }
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
    ws.send(JSON.stringify({
      type: 'status',
      connected: false,
      message: '远程服务器未连接'
    }));
    return;
  }

  const cached = metricsCollector.getSnapshot();
  if (cached) {
    ws.send(JSON.stringify({
      type: 'metrics',
      connected: true,
      data: cached
    }));
  } else {
    // Trigger immediate collection
    metricsCollector.collect()
      .then((data) => {
        if (ws.readyState === 1 && data) {
          ws.send(JSON.stringify({
            type: 'metrics',
            connected: true,
            data
          }));
        }
      })
      .catch((err) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'error',
            connected: false,
            error: err.message
          }));
        }
      });
  }
}
