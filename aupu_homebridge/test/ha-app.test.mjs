import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeConfig } from '../ha-app/run.mjs';

test('HA app first boot creates a separate bridge; restarts preserve pairing and one platform', () => {
  const first = makeConfig(undefined);
  assert.match(first.bridge.pin, /^\d{3}-\d{2}-\d{3}$/);
  assert.match(first.bridge.username, /^0E(:[0-9A-F]{2}){5}$/);
  const second = makeConfig(first, { name: '浴霸测试', primary_service: 'fan', include_temperature_sensor: false });
  assert.equal(first.bridge.pin, second.bridge.pin);
  assert.equal(first.bridge.username, second.bridge.username);
  assert.equal(second.platforms.length, 1);
  assert.equal(second.platforms[0].backend, 'simulation');
  assert.equal(second.platforms[0].primaryService, 'fan');
  assert.equal(second.platforms[0].includeTemperatureSensor, false);
  assert.equal(second.platforms[0].deviceId, first.platforms[0].deviceId);
});

test('HA app refuses broken saved identity and invalid options instead of resetting pairing', () => {
  assert.throws(() => makeConfig({ bridge: {} }));
  for (const options of [{ bridge_port: 80 }, { bridge_port: 51863.5 }, { primary_service: 'other' }]) {
    assert.throws(() => makeConfig(undefined, options));
  }
});

test('HA app uses managed credentials, explicit entity mapping, and a read-only default', () => {
  assert.throws(() => makeConfig(undefined, { backend: 'ha' }));
  const cfg = makeConfig(undefined, { backend: 'ha', information_entity: 'button.device_info', control_entity: 'climate.device' });
  assert.equal(cfg.platforms[0].ha.tokenEnv, 'SUPERVISOR_TOKEN');
  assert.equal(cfg.platforms[0].ha.readOnly, true);
  assert.equal(cfg.platforms[0].ha.fields.mainLight.attribute, 'light.on');
  assert.equal(cfg.platforms[0].ha.fields.fanSpeed.attribute, 'extend.ventilate_gear');
  assert.equal(cfg.platforms[0].ha.fields.nightLight.piid, 4);
  assert.equal(cfg.platforms[0].ha.temperature.min, 30);
  assert.equal(cfg.platforms[0].ha.temperature.max, 42);
});
