import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setImmediate as settled } from 'node:timers/promises';
import hap from '@homebridge/hap-nodejs';

import { AupuAccessory } from '../dist/accessory.js';
import { AupuPlatform } from '../dist/platform.js';
import { parseSettings } from '../dist/config.js';
import { SimulatedBackend } from '../dist/simulator.js';

// Real Homebridge API/PlatformAccessory and real HAP characteristics; no fake HAP implementation.
const require = createRequire(import.meta.url);
const hbDist = dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = await import(pathToFileURL(join(hbDist, 'api.js')).href);
const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {}, success() {} });
const C = hap.Characteristic;
const S = hap.Service;
function fixture(options = {}) {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('奥普 A3-Air', hap.uuid.generate('test-aupu'));
  const backend = new SimulatedBackend(24, 0);
  const controller = new AupuAccessory(accessory, hap, backend, log, parseSettings({ platform: 'AupuA3Air', ...options }));
  const char = (type, subtype, characteristic) => accessory.getServiceById(type, subtype).getCharacteristic(characteristic);
  return { accessory, backend, controller, char, api };
}

test('exactly one accessory, eight standard functional services, one primary and stable subtypes', () => {
  const f = fixture();
  assert.equal(f.accessory.services.length, 9); // 8 + AccessoryInformation
  assert.equal(f.accessory.services.filter(s => s.isPrimaryService).length, 1);
  assert.equal(f.accessory.getServiceById(S.HeaterCooler, 'heater').isPrimaryService, true);
  assert.equal(f.char(S.HeaterCooler, 'heater', C.Name).value, '奥普 A3-Air');
  assert.deepEqual(f.accessory.services.filter(s => s.subtype).map(s => s.subtype).sort(),
    ['main-light', 'night-light', 'heater', 'ventilation', 'blower', 'dry', 'deodorize', 'temperature'].sort());
  const types = new Set([S.AccessoryInformation.UUID, S.Lightbulb.UUID, S.HeaterCooler.UUID, S.Fanv2.UUID, S.Switch.UUID, S.TemperatureSensor.UUID]);
  for (const service of f.accessory.services) assert.ok(types.has(service.UUID));
  assert.deepEqual(f.char(S.HeaterCooler, 'heater', C.TargetHeaterCoolerState).props.validValues, [C.TargetHeaterCoolerState.HEAT]);
  assert.equal(f.char(S.Fanv2, 'ventilation', C.RotationSpeed).props.minStep, 20);
  f.controller.close();
});

test('real HAP SET/GET controls lights, heat, target, all five speeds and exclusive switches', async () => {
  const f = fixture();
  const set = (s, sub, c, v) => f.char(s, sub, c).handleSetRequest(v);
  await set(S.Lightbulb, 'main-light', C.On, true);
  await set(S.Lightbulb, 'night-light', C.On, true);
  await set(S.HeaterCooler, 'heater', C.HeatingThresholdTemperature, 30);
  await set(S.HeaterCooler, 'heater', C.TargetHeaterCoolerState, 1);
  await set(S.HeaterCooler, 'heater', C.Active, 1);
  assert.equal(await f.char(S.HeaterCooler, 'heater', C.CurrentHeaterCoolerState).handleGetRequest(), 2);
  await set(S.HeaterCooler, 'heater', C.Active, 0);
  for (let i = 0; i < 30; i++) f.backend.tick();
  for (let speed = 1; speed <= 5; speed++) {
    await set(S.Fanv2, 'ventilation', C.RotationSpeed, speed * 20);
    assert.equal(f.backend.snapshot().fanSpeed, speed);
    assert.equal(await f.char(S.HeaterCooler, 'heater', C.Active).handleGetRequest(), 0);
  }
  await set(S.Switch, 'dry', C.On, true);
  assert.equal(f.char(S.Fanv2, 'ventilation', C.Active).value, 0);
  await set(S.Switch, 'dry', C.On, false);
  for (let i = 0; i < 30; i++) f.backend.tick();
  await set(S.Switch, 'deodorize', C.On, true);
  assert.equal(f.char(S.Switch, 'dry', C.On).value, false);
  await set(S.Switch, 'dry', C.On, false); // Stale old-mode OFF.
  assert.equal(f.backend.snapshot().mode, 'deodorize');
  await set(S.Switch, 'deodorize', C.On, false);
  assert.equal(f.backend.snapshot().mode, 'off');
  assert.equal(f.backend.snapshot().mainLight, true);
  assert.equal(f.backend.snapshot().nightLight, true);
  f.controller.close();
});

test('all child services publish descriptive ConfiguredName and preserve user renames on restart', async () => {
  const f = fixture();
  const names = {
    'main-light': '主照明', 'night-light': '小夜灯', heater: 'AI 恒温取暖',
    ventilation: '换气排风', blower: '吹风送风', dry: '干燥', deodorize: '铂金除臭', temperature: '环境温度',
  };
  for (const service of f.accessory.services.filter(s => s.subtype)) {
    assert.equal(await service.getCharacteristic(C.ConfiguredName).handleGetRequest(), names[service.subtype]);
  }
  await f.char(S.Lightbulb, 'main-light', C.ConfiguredName).handleSetRequest('浴室主灯');
  f.controller.close();
  const second = new AupuAccessory(f.accessory, hap, new SimulatedBackend(24, 0), log, parseSettings({ platform: 'AupuA3Air' }));
  assert.equal(f.char(S.Lightbulb, 'main-light', C.ConfiguredName).value, '浴室主灯');
  assert.equal(f.accessory.services.length, 9);
  second.close();
});

test('backend events push temperature and mutually exclusive states without HomeKit polling', async () => {
  const f = fixture();
  await f.backend.execute({ type: 'mode', mode: 'heat', on: true });
  f.backend.tick();
  assert.ok(Math.abs(f.char(S.TemperatureSensor, 'temperature', C.CurrentTemperature).value - 24.2) < 0.001);
  assert.ok(Math.abs(f.char(S.HeaterCooler, 'heater', C.CurrentTemperature).value - 24.2) < 0.001);
  await f.backend.execute({ type: 'mode', mode: 'heat', on: false });
  for (let i = 0; i < 30; i++) f.backend.tick();
  await f.backend.execute({ type: 'mode', mode: 'dry', on: true });
  assert.equal(f.char(S.HeaterCooler, 'heater', C.Active).value, 0);
  assert.equal(f.char(S.Switch, 'dry', C.On).value, true);
  f.controller.close();
});

test('concurrent Home scene cannot bypass heating stop and cooldown in either backend or HAP cache', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.char(S.HeaterCooler, 'heater', C.Active).handleSetRequest(1),
    f.char(S.Fanv2, 'ventilation', C.Active).handleSetRequest(1),
    f.char(S.Switch, 'dry', C.On).handleSetRequest(true),
    f.char(S.Switch, 'deodorize', C.On).handleSetRequest(true),
  ]);
  await settled();
  assert.equal(results[0].status, 'fulfilled');
  assert.ok(results.slice(1).every(r => r.status === 'rejected'));
  assert.equal(f.backend.snapshot().mode, 'heat');
  assert.equal(f.char(S.HeaterCooler, 'heater', C.Active).value, 1);
  assert.equal(f.char(S.Fanv2, 'ventilation', C.Active).value, 0);
  assert.equal(f.char(S.Switch, 'dry', C.On).value, false);
  assert.equal(f.char(S.Switch, 'deodorize', C.On).value, false);
  f.controller.close();
});

test('invalid HAP requests and offline reads/writes return errors, not false success', async () => {
  const f = fixture();
  // HAP-NodeJS also validates the published props before invoking plugin handlers.
  await assert.rejects(f.char(S.HeaterCooler, 'heater', C.TargetHeaterCoolerState).handleSetRequest(2));
  await assert.rejects(f.char(S.HeaterCooler, 'heater', C.HeatingThresholdTemperature).handleSetRequest(99));
  f.backend.setOnline(false);
  await assert.rejects(f.char(S.Lightbulb, 'main-light', C.On).handleGetRequest());
  await assert.rejects(f.char(S.Lightbulb, 'main-light', C.On).handleSetRequest(true));
  assert.equal(f.backend.snapshot().mainLight, false);
  f.backend.setOnline(true);
  assert.equal(await f.char(S.Lightbulb, 'main-light', C.On).handleGetRequest(), false);
  f.controller.close();
});

test('cached services reused; optional sensor removal keeps current temperature on heater', () => {
  const f = fixture();
  const ids = f.accessory.services.map(s => s.UUID + s.subtype);
  f.controller.close();
  const backend = new SimulatedBackend(24, 0);
  const second = new AupuAccessory(f.accessory, hap, backend, log, parseSettings({ platform: 'AupuA3Air' }));
  assert.deepEqual(f.accessory.services.map(s => s.UUID + s.subtype), ids);
  second.close();
  const third = new AupuAccessory(f.accessory, hap, new SimulatedBackend(24, 0), log,
    parseSettings({ platform: 'AupuA3Air', includeTemperatureSensor: false, primaryService: 'fan' }));
  assert.equal(f.accessory.getServiceById(S.TemperatureSensor, 'temperature'), undefined);
  assert.equal(f.accessory.getServiceById(S.Fanv2, 'ventilation').isPrimaryService, true);
  assert.equal(f.char(S.HeaterCooler, 'heater', C.CurrentTemperature).value, 24);
  third.close();
});

test('dynamic platform registers only one accessory, reuses cached identity after restart', () => {
  const config = { platform: 'AupuA3Air', name: '奥普 A3-Air' };
  const api = new HomebridgeAPI();
  const registered = [];
  api.registerPlatformAccessories = (_plugin, _platform, accessories) => registered.push(...accessories);
  api.updatePlatformAccessories = () => {};
  new AupuPlatform(log, config, api);
  api.emit('didFinishLaunching');
  assert.equal(registered.length, 1);
  const id = registered[0].UUID;
  api.emit('shutdown');
  const api2 = new HomebridgeAPI();
  api2.registerPlatformAccessories = () => assert.fail('must reuse cache');
  api2.updatePlatformAccessories = a => assert.equal(a[0].UUID, id);
  const platform2 = new AupuPlatform(log, config, api2);
  platform2.configureAccessory(registered[0]);
  api2.emit('didFinishLaunching');
  assert.equal(registered[0].services.length, 9);
  api2.emit('shutdown');
});
