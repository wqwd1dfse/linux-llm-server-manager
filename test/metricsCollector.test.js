import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICS_SHELL, MetricsCollector, metricsCollector, parseBlockDevices, parseGpuDevices } from '../server/metricsCollector.js';

test('MetricsCollector: uses Bash for its Bash-array telemetry script', () => {
  assert.equal(METRICS_SHELL, 'bash');
});

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
test('MetricsCollector: parses unmounted SATA and NVMe physical devices from lsblk JSON', () => {
  const devices = parseBlockDevices([
    'LSBLK_JSON:',
    '{',
    '  "blockdevices": [',
    '    {"name":"sda","kname":"sda","path":"/dev/sda","type":"disk","tran":"sata","size":2000398934016,"model":"ST2000DM008","serial":"SATA123","rota":true,"vendor":"ATA"},',
    '    {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","tran":"nvme","size":1024209543168,"model":"Fast NVMe","serial":"NVME123","rota":false},',
    '    {"name":"loop0","path":"/dev/loop0","type":"loop","size":4096,"rota":false}',
    '  ]',
    '}'
  ]);

  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((device) => device.name), ['sda', 'nvme0n1']);
  assert.equal(devices[0].transport, 'sata');
  assert.equal(devices[0].rotational, true);
  assert.equal(devices[1].transport, 'nvme');
  assert.equal(devices[1].rotational, false);
});

test('MetricsCollector: detects a GPU from DRM or PCI sysfs without vendor utilities', () => {
  const gpu = parseGpuDevices([
    'DRM_GPU:card0|0000:03:00.0|0x1002|0x73bf|amdgpu|37|1073741824|17179869184|55000|125000000|VGA compatible controller: AMD Radeon RX 6800',
    'PCI_SYSFS:0000:03:00.0|0x1002|0x73bf|amdgpu|0x030000'
  ]);

  assert.equal(gpu.hasGpu, true);
  assert.equal(gpu.devices.length, 1);
  assert.equal(gpu.devices[0].vendor, 'AMD');
  assert.equal(gpu.devices[0].temperature, 55);
  assert.equal(gpu.devices[0].memoryTotalMb, 16384);
  assert.equal(gpu.devices[0].utilizationGpu, 37);
});

test('MetricsCollector: normalizes ambiguous Vega 20 inventory using measured VRAM and power', () => {
  const gpu = parseGpuDevices([
    'DRM_GPU:card0|0000:06:00.0|0x1002|0x66a1|amdgpu 6.12.95+deb13-amd64|0|12103680|17163091968|37000|17000000|VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Vega 20 [Radeon Pro VII/Radeon Instinct MI50 32GB] (rev 06)'
  ]);

  assert.equal(gpu.hasGpu, true);
  assert.equal(gpu.devices[0].name, 'AMD Vega 20 (16 GB VRAM)');
  assert.equal(gpu.devices[0].memoryUsedMb, 12);
  assert.equal(gpu.devices[0].memoryTotalMb, 16368);
  assert.equal(gpu.devices[0].powerDraw, '17.0 W');
  assert.equal(gpu.devices[0].driverVersion, 'amdgpu 6.12.95+deb13-amd64 (Linux DRM)');
});

test('MetricsCollector: NVIDIA telemetry wins over duplicate DRM inventory', () => {
  const gpu = parseGpuDevices([
    'NVIDIA_CSV:0, 00000000:01:00.0, NVIDIA RTX 4090, 555.42, 61, 92, 18, 24564, 12000, 12564, 320.5',
    'DRM_GPU:card0|0000:01:00.0|0x10de|0x2684|nvidia|||||||VGA compatible controller: NVIDIA RTX 4090'
  ]);

  assert.equal(gpu.devices.length, 1);
  assert.equal(gpu.type, 'nvidia');
  assert.equal(gpu.devices[0].name, 'NVIDIA RTX 4090');
  assert.equal(gpu.devices[0].powerDraw, '320.5 W');
});

test('MetricsCollector: stop remains final while an in-flight collection finishes', async () => {
  const collector = new MetricsCollector();
  let releaseCollection;
  let collectionStarted;
  const started = new Promise((resolve) => { collectionStarted = resolve; });
  collector.collect = async () => {
    collectionStarted();
    await new Promise((resolve) => { releaseCollection = resolve; });
    return null;
  };

  collector.start(0);
  await started;
  collector.stop();
  releaseCollection();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(collector.running, false);
  assert.equal(collector.timer, null);
});

function targetChangedError() {
  const error = new Error('Target server changed while the remote operation was pending');
  error.code = 'SSH_TARGET_CHANGED';
  return error;
}

function minimalMetricsOutput(hostname = 'metrics-host') {
  return [
    '---SYSINFO---',
    hostname,
    '6.12.0',
    'x86_64',
    'NAME=Linux',
    '10.0 0.0',
    '---CPU---',
    '0.10 0.20 0.30 1/1 1',
    'CPU_MEASURED: 125',
    '---MEM---',
    'MemTotal: 1024 kB',
    'MemAvailable: 512 kB',
    '---DISK---',
    'Filesystem 1-blocks Used Available Capacity Mounted on',
    '---DISK_INODES---',
    'Filesystem Inodes IUsed IFree IUse% Mounted on',
    '---DISKSTATS---',
    '---BLOCK_DEVICES---',
    '---NET---',
    '---GPU---',
    '---TOP_CPU_MEM---',
    'PID USER %CPU %MEM COMMAND'
  ].join('\n');
}

test('MetricsCollector: binds collection to its initial target and drops a stale completion', async () => {
  let connection = { connected: true, host: 'root@alpha:22' };
  let generation = 7;
  let releaseCommand;
  let markCommandStarted;
  let receivedOptions;
  const commandStarted = new Promise((resolve) => { markCommandStarted = resolve; });
  const commandGate = new Promise((resolve) => { releaseCommand = resolve; });

  const collector = new MetricsCollector({
    getConnectionStatusFn: () => ({ ...connection }),
    captureTargetContextFn: () => Object.freeze({ generation, targetId: connection.host }),
    assertTargetContextFn: (context) => {
      if (context.generation !== generation || context.targetId !== connection.host) {
        throw targetChangedError();
      }
      return true;
    },
    executeCommandFn: async (_shell, _args, options) => {
      receivedOptions = options;
      markCommandStarted();
      await commandGate;
      return { success: true, stdout: minimalMetricsOutput('alpha') };
    }
  });
  collector.currentHost = connection.host;
  collector.currentTargetGeneration = generation;
  collector.latestSnapshot = { os: { hostname: 'previous-alpha' } };
  collector.history = [{ t: Date.now(), cpu: 1 }];
  const notifications = [];
  collector.addListener((snapshot) => notifications.push(snapshot));

  const pending = collector.collect();
  await commandStarted;
  connection = { connected: true, host: 'root@bravo:22' };
  generation += 1;
  releaseCommand();

  assert.equal(await pending, null);
  assert.deepEqual(receivedOptions.expectedTargetContext, {
    generation: 7,
    targetId: 'root@alpha:22'
  });
  assert.equal(collector.latestSnapshot, null);
  assert.equal(collector.currentHost, 'root@bravo:22');
  assert.equal(collector.currentTargetGeneration, 8);
  assert.deepEqual(collector.history, []);
  assert.deepEqual(notifications, [null]);
});

test('MetricsCollector: a new target cannot reuse a snapshot while the old target is collecting', async () => {
  let connection = { connected: true, host: 'root@alpha:22' };
  let generation = 3;
  let releaseCommand;
  let markCommandStarted;
  const commandStarted = new Promise((resolve) => { markCommandStarted = resolve; });
  const commandGate = new Promise((resolve) => { releaseCommand = resolve; });

  const collector = new MetricsCollector({
    getConnectionStatusFn: () => ({ ...connection }),
    captureTargetContextFn: () => Object.freeze({ generation, targetId: connection.host }),
    assertTargetContextFn: (context) => {
      if (context.generation !== generation || context.targetId !== connection.host) {
        throw targetChangedError();
      }
      return true;
    },
    executeCommandFn: async () => {
      markCommandStarted();
      await commandGate;
      return { success: true, stdout: minimalMetricsOutput('alpha') };
    }
  });
  collector.latestSnapshot = { os: { hostname: 'alpha-cache' } };
  collector.currentHost = connection.host;
  collector.currentTargetGeneration = generation;

  const alphaCollection = collector.collect();
  await commandStarted;
  connection = { connected: true, host: 'root@bravo:22' };
  generation += 1;

  assert.equal(await collector.collect(), null);
  assert.equal(collector.latestSnapshot, null);
  assert.equal(collector.currentHost, 'root@bravo:22');

  releaseCommand();
  assert.equal(await alphaCollection, null);
});

test('MetricsCollector: drops a completion after transport disconnect even without a generation bump', async () => {
  let connection = { connected: true, host: 'root@alpha:22' };
  const generation = 12;
  let releaseCommand;
  let markCommandStarted;
  const commandStarted = new Promise((resolve) => { markCommandStarted = resolve; });
  const commandGate = new Promise((resolve) => { releaseCommand = resolve; });

  const collector = new MetricsCollector({
    getConnectionStatusFn: () => ({ ...connection }),
    captureTargetContextFn: () => Object.freeze({ generation, targetId: connection.host }),
    assertTargetContextFn: () => true,
    executeCommandFn: async () => {
      markCommandStarted();
      await commandGate;
      return { success: true, stdout: minimalMetricsOutput('alpha') };
    }
  });
  collector.currentHost = connection.host;
  collector.currentTargetGeneration = generation;
  collector.latestSnapshot = { os: { hostname: 'previous-alpha' } };
  const notifications = [];
  collector.addListener((snapshot) => notifications.push(snapshot));

  const pending = collector.collect();
  await commandStarted;
  connection = { connected: false, host: 'root@alpha:22' };
  releaseCommand();

  assert.equal(await pending, null);
  assert.equal(collector.latestSnapshot, null);
  assert.equal(collector.currentTargetGeneration, null);
  assert.deepEqual(notifications, [null]);
});
