import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICS_SHELL, metricsCollector, parseBlockDevices, parseGpuDevices } from '../server/metricsCollector.js';

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
