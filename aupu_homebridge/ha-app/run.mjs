import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSettings } from '../dist/config.js';

export function makeConfig(existing, options = {}) {
  const platform = {
    platform: 'AupuA3Air',
    backend: options.backend ?? 'simulation',
    name: options.name ?? '奥普 A3-Air',
    deviceId: 'aupu-a3-air-virtual-1',
    primaryService: options.primary_service ?? 'heater',
    includeTemperatureSensor: options.include_temperature_sensor ?? true,
  };
  if (platform.backend === 'ha') {
    if (!options.information_entity || !options.control_entity) throw new Error('HA entity mapping is required');
    platform.ha = {
      ...JSON.parse(readFileSync(new URL('./aupu-mapping.json', import.meta.url), 'utf8')),
      informationEntity: options.information_entity,
      controlEntity: options.control_entity,
      readOnly: options.allow_control !== true,
    };
  }
  parseSettings(platform);
  const port = options.bridge_port ?? 51863;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid bridge_port');
  if (existing && (!existing.bridge?.username || !existing.bridge?.pin)) {
    throw new Error('Existing bridge identity is invalid; refusing to reset pairing automatically');
  }
  let identity = existing?.bridge;
  if (!identity) {
    let digits;
    do { digits = randomInt(100_000_000).toString().padStart(8, '0'); }
    while (/^(\d)\1{7}$/.test(digits) || ['12345678', '87654321'].includes(digits));
    identity = {
      username: ['0E', ...randomBytes(5).toString('hex').match(/../g)].join(':').toUpperCase(),
      pin: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`,
    };
  }
  return {
    bridge: { ...identity, name: existing?.bridge?.name ?? 'Aupu A3-Air Bridge', port, advertiser: 'ciao' },
    plugins: ['homebridge-aupu-a3-air'], accessories: [], platforms: [platform],
  };
}

function main() {
  const storage = '/data';
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  const path = join(storage, 'config.json');
  const options = JSON.parse(readFileSync(join(storage, 'options.json'), 'utf8'));
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  const config = makeConfig(existing, options);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
  console.log(`Aupu backend=${config.platforms[0].backend}; readOnly=${config.platforms[0].ha?.readOnly ?? false}; pairing storage=/data`);
  console.log(`Node ${process.version}; Homebridge host port ${config.bridge.port}`);
  const child = spawn(process.execPath, [
    '/opt/homebridge-runtime/node_modules/homebridge/bin/homebridge.js',
    '-U', storage, '-P', root, '--strict-plugin-resolution',
  ], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Homebridge failed to start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 0; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
