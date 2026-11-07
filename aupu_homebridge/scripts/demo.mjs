import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storage = join(root, '.homebridge-demo');
mkdirSync(storage, { recursive: true, mode: 0o700 });
const configPath = join(storage, 'config.json');
if (!existsSync(configPath)) {
  const config = JSON.parse(readFileSync(join(root, 'examples', 'simulation.json'), 'utf8'));
  config.bridge.username = ['0E', ...randomBytes(5).toString('hex').match(/../g)].join(':').toUpperCase();
  let pin;
  do { pin = randomInt(100_000_000).toString().padStart(8, '0'); }
  while (/^(\d)\1{7}$/.test(pin) || ['12345678', '87654321'].includes(pin));
  config.bridge.pin = `${pin.slice(0, 3)}-${pin.slice(3, 5)}-${pin.slice(5)}`;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
console.log(`虚拟浴霸配置与配对存储：${storage}`);
console.log('仅模拟；同一网段 iPhone 扫描终端二维码添加。Ctrl+C 停止；保留目录以保留配对。');
const child = spawn(process.execPath, [
  join(root, 'node_modules', 'homebridge', 'bin', 'homebridge.js'),
  '-U', storage, '-P', root, '--strict-plugin-resolution', '-D',
], { cwd: root, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
