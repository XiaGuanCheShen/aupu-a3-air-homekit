import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginPath = process.env.AUPU_PLUGIN_PATH ?? root;
const storage = mkdtempSync(join(tmpdir(), 'aupu-a3-air-smoke-'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const config = JSON.parse(readFileSync(join(root, 'examples', 'simulation.json'), 'utf8'));
config.bridge.port = port;
config.bridge.username = ['0E', ...randomBytes(5).toString('hex').match(/../g)].join(':').toUpperCase();
config.bridge.bind = ['127.0.0.1']; // Restricts discovery. HAP itself still requires authentication.
writeFileSync(join(storage, 'config.json'), JSON.stringify(config), { mode: 0o600 });

async function run() {
  let output = '';
  const child = spawn(process.execPath, [
    join(root, 'node_modules', 'homebridge', 'bin', 'homebridge.js'),
    '-U', storage, '-P', pluginPath, '--strict-plugin-resolution', '-Q',
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let childError;
  child.on('error', error => { childError = error; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    const deadline = Date.now() + 25000;
    let status;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null) throw new Error('Homebridge exited before ready');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/accessories`, { signal: AbortSignal.timeout(1000) });
        status = response.status;
        await response.text();
        if (status === 470) break;
      } catch { /* Wait only for this new process's listener. */ }
      await delay(200);
    }
    assert.equal(status, 470, 'Unpaired HAP HTTP must reject requests (no insecure mode)');
    assert.match(output, /已注册 1 台虚拟浴霸、8 个功能服务/);
    assert.doesNotMatch(output, /Cannot add a Service|unhandled|Invalid plugin|No plugins found|invalid.*characteristic|supplied illegal value/i);
    const path = join(storage, 'accessories', 'cachedAccessories');
    assert.ok(existsSync(path), 'Homebridge must persist the dynamic accessory');
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(cached.length, 1);
    assert.equal(cached[0].services.length, 9);
    assert.equal(cached[0].services.filter(s => s.primaryService).length, 1);
    return cached[0];
  } catch (error) {
    // No pairing code or key material is copied to reports.
    console.error(output.replace(/\d{3}-\d{2}-\d{3}/g, '[redacted pairing code]')
      .replace(/X-HM:\/\/[A-Z0-9]+/g, '[redacted setup URI]'));
    throw error;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

const first = await run();
const second = await run();
assert.equal(first.UUID, second.UUID, 'Restart must preserve accessory identity');
assert.deepEqual(first.services.map(s => s.UUID + s.subtype), second.services.map(s => s.UUID + s.subtype));
const report = {
  verifiedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  homebridge: '2.5.0',
  hapNodeJS: '2.3.0',
  pluginVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  scope: 'isolated simulation process; deployed HA/iPhone acceptance is documented separately',
  pluginInput: process.env.AUPU_PLUGIN_PATH ? 'packed-artifact' : 'source-tree',
  accessoryCount: 1,
  functionalServiceCount: 8,
  primaryServiceCount: 1,
  restartPreservesIdentity: true,
  unauthenticatedHapHttpStatus: 470,
  appleHomePairingAndLayout: 'outside the scope of this isolated process',
  realHardwareConnected: false,
};
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'smoke-result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
