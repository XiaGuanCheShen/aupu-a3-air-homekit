import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SimulatedBackend } from '../dist/simulator.js';
import { parseSettings } from '../dist/config.js';
import { percentToSpeed } from '../dist/mapping.js';

test('all operating modes are exclusive; stale OFF cannot stop another mode', async () => {
  const backend = new SimulatedBackend(24, 0);
  const modes = ['heat', 'vent', 'blow', 'dry', 'deodorize'];
  for (const from of modes) for (const to of modes) {
    if (backend.snapshot().mode !== 'off') await backend.execute({ type: 'mode', mode: backend.snapshot().mode, on: false });
    for (let i = 0; i < 30; i++) backend.tick();
    await backend.execute({ type: 'mode', mode: from, on: true });
    if (['heat', 'dry'].includes(from) && from !== to) {
      await assert.rejects(backend.execute({ type: 'mode', mode: to, on: true }), { code: 'busy' });
      await backend.execute({ type: 'mode', mode: from, on: false });
      for (let i = 0; i < 30; i++) backend.tick();
    }
    await backend.execute({ type: 'mode', mode: to, on: true });
    assert.equal(backend.snapshot().mode, to);
    if (from !== to) {
      await backend.execute({ type: 'mode', mode: from, on: false });
      assert.equal(backend.snapshot().mode, to);
    }
  }
  backend.close();
});

test('lights remain independently controllable through all modes', async () => {
  const backend = new SimulatedBackend(24, 0);
  await backend.execute({ type: 'mainLight', on: true });
  await backend.execute({ type: 'nightLight', on: true });
  await backend.execute({ type: 'mode', mode: 'dry', on: true });
  await backend.execute({ type: 'mainLight', on: false });
  assert.equal(backend.snapshot().nightLight, true);
  assert.equal(backend.snapshot().mainLight, false);
  assert.equal(backend.snapshot().mode, 'dry');
  backend.close();
});

test('five speeds, zero/off, saved speed, quantization and input validation', async () => {
  const backend = new SimulatedBackend(24, 0);
  for (let speed = 1; speed <= 5; speed++) {
    await backend.execute({ type: 'fanSpeed', value: percentToSpeed(speed * 20) });
    assert.equal(backend.snapshot().fanSpeed, speed);
    assert.equal(backend.snapshot().mode, 'vent');
  }
  await backend.execute({ type: 'fanSpeed', value: 0 });
  assert.equal(backend.snapshot().mode, 'off');
  await backend.execute({ type: 'mode', mode: 'vent', on: true });
  assert.equal(backend.snapshot().fanSpeed, 5);
  assert.equal(percentToSpeed(1), 1);
  assert.equal(percentToSpeed(49), 2);
  assert.equal(percentToSpeed(100), 5);
  for (const invalid of [-1, 101, NaN, '40']) assert.throws(() => percentToSpeed(invalid));
  for (const value of [-1, 6, 1.5, NaN]) {
    await assert.rejects(backend.execute({ type: 'fanSpeed', value }), { code: 'invalid' });
  }
  backend.close();
});

test('temperature evolves, reaches thermostat idle, target changes do not turn on heat', async () => {
  const backend = new SimulatedBackend(24, 0, 25);
  await backend.execute({ type: 'targetTemperature', value: 25 });
  assert.equal(backend.snapshot().mode, 'off');
  await backend.execute({ type: 'mode', mode: 'heat', on: true });
  assert.equal(backend.snapshot().heating, true);
  for (let i = 0; i < 8; i++) backend.tick();
  assert.ok(backend.snapshot().currentTemperature > 24);
  assert.equal(backend.snapshot().heating, false);
  await backend.execute({ type: 'mode', mode: 'heat', on: false });
  for (let i = 0; i < 30; i++) backend.tick();
  await backend.execute({ type: 'mode', mode: 'dry', on: true });
  assert.equal(backend.snapshot().heating, false);
  for (let i = 0; i < 1000; i++) backend.tick();
  assert.equal(backend.snapshot().currentTemperature, 24);
  for (const value of [15, 41, 24.2, NaN, '25']) {
    await assert.rejects(backend.execute({ type: 'targetTemperature', value }), { code: 'invalid' });
  }
  backend.close();
});

test('duplicates do not emit extra state; offline errors and cleanup are explicit', async () => {
  const backend = new SimulatedBackend(24, 0);
  let updates = 0;
  const unsubscribe = backend.onState(() => updates++);
  await backend.execute({ type: 'mainLight', on: true });
  await backend.execute({ type: 'mainLight', on: true });
  assert.equal(updates, 1);
  backend.setOnline(false);
  await assert.rejects(backend.execute({ type: 'mainLight', on: false }), { code: 'offline' });
  assert.equal(backend.snapshot().mainLight, true);
  backend.setOnline(true);
  unsubscribe();
  backend.close();
  await assert.rejects(backend.execute({ type: 'mainLight', on: false }), { code: 'offline' });
});

test('phase two cannot accidentally start, config rejects invalid boundary values', () => {
  assert.equal(parseSettings({ platform: 'AupuA3Air' }).name, '奥普 A3-Air');
  for (const config of [
    { backend: 'ha' }, { primaryService: 'custom' }, { includeTemperatureSensor: 'false' },
    { simulation: { tickSeconds: 0 } }, { simulation: { targetTemperature: 28.2 } },
  ]) assert.throws(() => parseSettings({ platform: 'AupuA3Air', ...config }));
});
