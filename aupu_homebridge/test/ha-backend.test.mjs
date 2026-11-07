import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { HaBackend, decodeHaState } from '../dist/ha-backend.js';
import { parseHaConfig } from '../dist/ha-contract.js';
import { AupuAccessory } from '../dist/accessory.js';
import { parseSettings } from '../dist/config.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import hap from '@homebridge/hap-nodejs';

const template = JSON.parse(readFileSync(new URL('../ha-app/aupu-mapping.json', import.meta.url), 'utf8'));
process.env.AUPU_TEST_HA_TOKEN = 'local-test-credential';
const baseAttributes = () => ({
  available: true, updater: 'local', updated_at: new Date().toISOString(),
  'light.on': false, 'extend.night_light': false, 'ptc_bath_heater.mode': 0,
  'target_temperature-3-3': 37, 'environment.temperature': 23,
  'extend.ventilate_gear': 5, 'fan_control.fan_level': 3, 'extend.count_down': 0, 'ptc_bath_heater.fault': 0,
});
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Condition timed out'); await delay(10); }
}

async function fixture(t, overrides = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const config = parseHaConfig({ ...template, url: `http://127.0.0.1:${server.address().port}`,
    tokenEnv: 'AUPU_TEST_HA_TOKEN', informationEntity: 'button.aupu_info', controlEntity: 'climate.aupu', readOnly: false,
    ...overrides });
  const f = { server, config, attrs: baseAttributes(), calls: [], writes: [], rejectWrite: false, ignoreWrite: false,
    snapshotRace: false, connections: 0, snapshot: () => ({ entity_id: config.informationEntity, state: 'unknown',
      attributes: { ...f.attrs }, last_updated: new Date().toISOString() }) };
  f.publish = patch => {
    const state = f.snapshot();
    Object.assign(state.attributes, { updated_at: state.last_updated }, patch);
    for (const ws of server.clients) if (ws.subscribed) ws.send(JSON.stringify({ type: 'event', id: ws.subscription,
      event: { event_type: 'state_changed', data: { entity_id: config.informationEntity, new_state: state } } }));
  };
  f.push = patch => {
    Object.assign(f.attrs, patch);
    if (!('updated_at' in patch)) f.attrs.updated_at = new Date().toISOString();
    f.publish(patch);
  };
  server.on('connection', ws => {
    f.connections++;
    ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', bytes => {
      const m = JSON.parse(bytes.toString());
      if (m.type === 'auth') {
        assert.equal(m.access_token, 'local-test-credential');
        ws.send(JSON.stringify({ type: 'auth_ok' })); return;
      }
      f.calls.push(m);
      const reply = result => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      if (m.type === 'subscribe_events') { ws.subscribed = true; ws.subscription = m.id; reply(null); }
      else if (m.type === 'get_states') {
        const old = f.snapshot();
        if (f.snapshotRace) f.push({ 'environment.temperature': 27 });
        reply([old]);
      } else if (m.type === 'ping') ws.send(JSON.stringify({ id: m.id, type: 'pong' }));
      else if (m.type === 'call_service') {
        assert.equal(m.domain, 'xiaomi_miot');
        assert.equal(m.service_data.entity_id, config.controlEntity);
        if (m.service === 'get_properties') {
          assert.equal(m.service_data.update_entity, false);
          const values = Object.fromEntries(Object.values(config.fields).map(fld => [fld.attribute, f.attrs[fld.attribute]]));
          if (f.delayNextRead) {
            const ms = f.delayNextRead; f.delayNextRead = 0;
            setTimeout(() => reply({ response: values }), ms);
          } else reply({ response: values });
        } else if (m.service === 'set_miot_property') {
          const cmd = m.service_data;
          f.writes.push(cmd);
          if (f.disconnectOnWrite) { f.disconnectOnWrite = false; ws.terminate(); return; }
          const field = Object.values(config.fields).find(fld => fld.siid === cmd.siid && fld.piid === cmd.piid);
          assert.ok(field, 'Only mapped properties may be written');
          if (!f.rejectWrite && !f.ignoreWrite) f.push({ [field.attribute]: cmd.value });
          reply({ response: [{ siid: cmd.siid, piid: cmd.piid, code: f.rejectWrite ? -4004 : 0 }] });
        } else assert.fail('Unexpected service');
      } else assert.fail('Unexpected request');
    });
  });
  f.backend = new HaBackend(config);
  t.after(async () => {
    f.backend.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await until(() => f.backend.snapshot().online);
  return f;
}

test('HA startup subscribes before snapshot, reads real data, and never writes simulated defaults', async t => {
  const f = await fixture(t);
  assert.equal(f.backend.snapshot().currentTemperature, 23);
  assert.equal(f.backend.snapshot().targetTemperature, 37);
  assert.equal(f.backend.snapshot().mode, 'off');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.calls.slice(0, 2).map(m => m.type), ['subscribe_events', 'get_states']);
  f.push({ 'environment.temperature': 24, 'light.on': true });
  await until(() => f.backend.snapshot().mainLight);
  assert.equal(f.backend.snapshot().currentTemperature, 24);
  assert.equal(f.writes.length, 0, 'Remote state changes must not echo commands');
});

test('HA simultaneous refreshes share one physical read', async t => {
  const f = await fixture(t);
  await f.backend.refresh();
  const before = f.backend.diagnostics().reads;
  await Promise.all([f.backend.refresh(), f.backend.refresh(), f.backend.refresh()]);
  assert.equal(f.backend.diagnostics().reads, before + 1);
});

test('HA light writes are acknowledged/read back and repeated desired values are deduplicated', async t => {
  const f = await fixture(t);
  await f.backend.execute({ type: 'mainLight', on: true });
  await f.backend.execute({ type: 'mainLight', on: true });
  await f.backend.execute({ type: 'nightLight', on: true });
  assert.deepEqual(f.writes.map(w => [w.siid, w.piid, w.value]), [[2, 1, true], [6, 4, true]]);
  assert.equal(f.backend.snapshot().nightLight, true);
});

test('HA mode writes stay exclusive and a stale old-mode OFF does not stop the current mode', async t => {
  const f = await fixture(t);
  for (const mode of ['vent', 'blow', 'deodorize']) {
    await f.backend.execute({ type: 'mode', mode, on: true });
    assert.equal(f.backend.snapshot().mode, mode);
  }
  const count = f.writes.length;
  await f.backend.execute({ type: 'mode', mode: 'heat', on: false });
  assert.equal(f.backend.snapshot().mode, 'deodorize');
  assert.equal(f.writes.length, count);
  await f.backend.execute({ type: 'mode', mode: 'deodorize', on: false });
  assert.equal(f.backend.snapshot().mode, 'off');
  assert.ok(f.writes.every(w => w.siid === 3 && w.piid === 2));
});

test('HA rapid light requests coalesce only unsent same-light commands and confirm the last target', async t => {
  const f = await fixture(t);
  await f.backend.refresh();
  const start = f.calls.length;
  const first = f.backend.execute({ type: 'mainLight', on: true });
  await until(() => f.writes.length === 1);
  const pending = [false, true, false, true, false].map(on => f.backend.execute({ type: 'mainLight', on }));
  await Promise.all([first, ...pending]);
  assert.deepEqual(f.writes.map(w => w.value), [true, false]);
  assert.equal(f.backend.snapshot().mainLight, false);
  const lightReads = f.calls.slice(start).filter(c => c.service === 'get_properties');
  assert.ok(lightReads.every(c => c.service_data.mapping.length === 1));
});

test('HA a late poll with an older measured timestamp cannot overwrite a confirmed light state', async t => {
  const f = await fixture(t);
  await f.backend.execute({ type: 'mainLight', on: true });
  f.push({ 'light.on': false, updated_at: new Date(Date.now() - 2000).toISOString() });
  await delay(30);
  assert.equal(f.backend.snapshot().mainLight, true);
  f.push({ 'light.on': false });
  await until(() => !f.backend.snapshot().mainLight);
});

test('HA target uses actual 30–42/1 range; setting it never activates heating', async t => {
  const f = await fixture(t);
  for (const value of [16, 29, 37.5, 43]) await assert.rejects(f.backend.execute({ type: 'targetTemperature', value }), { code: 'invalid' });
  await f.backend.execute({ type: 'targetTemperature', value: 42 });
  assert.deepEqual(f.writes.map(w => [w.siid, w.piid, w.value]), [[3, 3, 42]]);
  assert.equal(f.backend.snapshot().mode, 'off');
});

test('HA fan uses ventilation 6.5, not blower 5.2; zero stops and preserves saved gear', async t => {
  const f = await fixture(t);
  await f.backend.execute({ type: 'fanSpeed', value: 2 });
  assert.deepEqual(f.writes.map(w => [w.siid, w.piid, w.value]), [[6, 5, 2], [3, 2, 7]]);
  await f.backend.execute({ type: 'fanSpeed', value: 0 });
  assert.equal(f.backend.snapshot().mode, 'off');
  assert.equal(f.backend.snapshot().fanSpeed, 2);
  await f.backend.execute({ type: 'mode', mode: 'vent', on: true });
  assert.equal(f.backend.snapshot().fanSpeed, 2);
});

test('HA rejected or unconfirmed writes fail and are never retried', async t => {
  const f = await fixture(t);
  f.rejectWrite = true;
  await assert.rejects(f.backend.execute({ type: 'nightLight', on: true }));
  assert.equal(f.writes.length, 1);
  f.rejectWrite = false; f.ignoreWrite = true;
  await assert.rejects(f.backend.execute({ type: 'nightLight', on: true }));
  assert.equal(f.writes.length, 2, 'Readback retries must not repeat the write');
  assert.equal(f.backend.snapshot().nightLight, false);
});

test('HA read-only mode and fault gates block motor/heater writes', async t => {
  const ro = await fixture(t, { readOnly: true });
  await assert.rejects(ro.backend.execute({ type: 'mainLight', on: true }), { code: 'readonly' });
  assert.equal(ro.writes.length, 0);
  const f = await fixture(t);
  f.push({ 'ptc_bath_heater.fault': 1 });
  await until(() => f.backend.snapshot().fault === 1);
  await assert.rejects(f.backend.execute({ type: 'mode', mode: 'heat', on: true }));
  await assert.rejects(f.backend.execute({ type: 'targetTemperature', value: 38 }));
  assert.equal(f.writes.length, 0);
});

test('HA cruise deodorizing remains active; unrepresented blower mode is not invented as OFF', async t => {
  const f = await fixture(t);
  f.push({ 'ptc_bath_heater.mode': 23 });
  await until(() => f.backend.snapshot().mode === 'deodorize');
  await f.backend.execute({ type: 'mode', mode: 'deodorize', on: true });
  assert.equal(f.writes.length, 0);
  f.push({ 'ptc_bath_heater.mode': 42 });
  await until(() => f.backend.snapshot().mode === 'other');
  await assert.rejects(f.backend.execute({ type: 'mode', mode: 'heat', on: false }));
  assert.equal(f.writes.length, 0);
});

test('HA disconnect rejects controls; reconnect restores actual state without replaying a command', async t => {
  const f = await fixture(t);
  for (const ws of f.server.clients) ws.terminate();
  await until(() => !f.backend.snapshot().online);
  await assert.rejects(f.backend.execute({ type: 'mode', mode: 'heat', on: true }));
  f.attrs['extend.night_light'] = true;
  await until(() => f.backend.snapshot().online && f.connections > 1, 4000);
  assert.equal(f.backend.snapshot().nightLight, true);
  assert.equal(f.writes.length, 0);
});

test('HA disconnect during a write also rejects the queued heater request; neither is replayed', async t => {
  const f = await fixture(t);
  f.disconnectOnWrite = true;
  const results = await Promise.allSettled([
    f.backend.execute({ type: 'mainLight', on: true }),
    f.backend.execute({ type: 'mode', mode: 'heat', on: true }),
  ]);
  assert.ok(results.every(r => r.status === 'rejected'));
  await until(() => f.backend.snapshot().online && f.connections > 1, 4000);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].siid, 2);
  assert.equal(f.backend.snapshot().mode, 'off');
});

test('HA invalid/missing data is unavailable; a fresh local event recovers without writes', async t => {
  const f = await fixture(t);
  f.push({ 'extend.night_light': undefined });
  await until(() => !f.backend.snapshot().online);
  f.push({ 'extend.night_light': false });
  await until(() => f.backend.snapshot().online);
  f.push({ updater: 'cloud' });
  await until(() => !f.backend.snapshot().online);
  f.push({ updater: 'local', updated_at: new Date(Date.now() - 120000).toISOString() });
  await delay(20); assert.equal(f.backend.snapshot().online, false);
  f.push({ updater: 'local' });
  await until(() => f.backend.snapshot().online);
  assert.equal(f.writes.length, 0);
});

test('HA mapping validation rejects literal credentials, missing fields, duplicate modes and invalid ranges', () => {
  for (const patch of [{ token: 'secret' }, { temperature: { min: 42, max: 30, step: 1 } },
    { modes: { off: 0, heat: 0, vent: 7, blow: 2, dry: 4, deodorize: 21 } }, { fields: {} },
    { url: 'http://user:password@example.test' }]) assert.throws(() => parseHaConfig({ ...template, ...patch }));
  assert.throws(() => decodeHaState({ ...baseAttributes(), 'extend.night_light': 'false' }, parseHaConfig(template)));
});

test('real HAP characteristics use HA range/state, handle unsupported mode honestly, and write only on explicit SET', async t => {
  const f = await fixture(t);
  const require = createRequire(import.meta.url);
  const { HomebridgeAPI } = await import(pathToFileURL(join(dirname(require.resolve('homebridge')), 'api.js')).href);
  const api = new HomebridgeAPI();
  const acc = new api.platformAccessory('奥普 A3-Air', hap.uuid.generate('real-ha-hap-test'));
  const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
  const control = new AupuAccessory(acc, hap, f.backend, log, parseSettings({ platform: 'AupuA3Air', backend: 'ha', ha: f.config }));
  t.after(() => control.close());
  const heater = acc.getServiceById(hap.Service.HeaterCooler, 'heater');
  const target = heater.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature);
  assert.equal(target.props.minValue, 30);
  assert.equal(target.props.maxValue, 42);
  assert.equal(target.props.minStep, 1);
  assert.equal(await target.handleGetRequest(), 37);
  assert.equal(f.writes.length, 0);
  const main = acc.getServiceById(hap.Service.Lightbulb, 'main-light').getCharacteristic(hap.Characteristic.On);
  await main.handleSetRequest(true);
  assert.equal(f.writes.length, 1);
  await Promise.all([main.handleSetRequest(false), main.handleSetRequest(true), main.handleSetRequest(false)]);
  await delay(5); // HAP caches each SET value after its callback; the final push must win.
  assert.equal(main.value, false);
  assert.equal(await main.handleGetRequest(), false);
  assert.equal(f.writes.length, 2);
  f.push({ 'ptc_bath_heater.mode': 42 });
  await until(() => f.backend.snapshot().mode === 'other');
  await assert.rejects(heater.getCharacteristic(hap.Characteristic.Active).handleGetRequest());
  assert.equal(await main.handleGetRequest(), false);
  assert.equal(acc.services.length, 9);
});

test('HA blower uses mode 2 and gear 5.2 independently of ventilation 6.5', async t => {
  const f = await fixture(t);
  await f.backend.execute({ type: 'blowerSpeed', value: 2 });
  assert.deepEqual(f.writes.map(w => [w.siid, w.piid, w.value]), [[5, 2, 2], [3, 2, 2]]);
  assert.equal(f.backend.snapshot().mode, 'blow');
  assert.equal(f.backend.snapshot().fanSpeed, 5);
  await f.backend.execute({ type: 'fanSpeed', value: 4 });
  assert.equal(f.backend.snapshot().mode, 'vent');
  assert.equal(f.backend.snapshot().blowerSpeed, 2);
  const count = f.writes.length;
  await f.backend.execute({ type: 'blowerSpeed', value: 0 });
  assert.equal(f.writes.length, count, 'Old blower OFF must not stop ventilation');
  assert.equal(f.backend.snapshot().mode, 'vent');
});

test('HA actual cooldown blocks every motor startup path, allows lamps, and never replays blocked requests', async t => {
  const f = await fixture(t);
  f.push({ 'extend.count_down': 25 });
  await until(() => f.backend.snapshot().cooldownSeconds === 25);
  const starts = ['heat', 'dry', 'vent', 'blow', 'deodorize'].map(mode => ({ type: 'mode', mode, on: true }));
  starts.push({ type: 'fanSpeed', value: 2 }, { type: 'blowerSpeed', value: 3 });
  for (const command of starts) await assert.rejects(f.backend.execute(command), { code: 'busy' });
  assert.equal(f.writes.length, 0);
  await f.backend.execute({ type: 'mainLight', on: true });
  await f.backend.execute({ type: 'nightLight', on: true });
  assert.ok(f.writes.every(w => w.siid === 2 || (w.siid === 6 && w.piid === 4)));
  const writes = f.writes.length;
  f.push({ 'extend.count_down': 0 });
  await until(() => f.backend.snapshot().cooldownSeconds === 0);
  await delay(30);
  assert.equal(f.writes.length, writes, 'Cooldown completion must not automatically start an earlier rejected mode');
  await f.backend.execute({ type: 'mode', mode: 'blow', on: true });
  assert.equal(f.backend.snapshot().mode, 'blow');
});

test('HA requires heat/dry OFF first and protects the gap before shutdown countdown appears', async t => {
  const f = await fixture(t);
  for (const raw of [18, 4]) {
    f.push({ 'ptc_bath_heater.mode': raw });
    await until(() => f.backend.snapshot().rawMode === raw);
    const before = f.writes.length;
    await assert.rejects(f.backend.execute({ type: 'mode', mode: 'deodorize', on: true }), { code: 'busy' });
    assert.equal(f.writes.length, before);
    await f.backend.execute({ type: 'mode', mode: raw === 18 ? 'heat' : 'dry', on: false });
    assert.equal(f.backend.snapshot().mode, 'off');
    await assert.rejects(f.backend.execute({ type: 'blowerSpeed', value: 1 }), { code: 'busy' });
    await delay(2050);
    await f.backend.execute({ type: 'mode', mode: 'blow', on: true });
    assert.equal(f.backend.snapshot().mode, 'blow');
  }
});

test('HA invalid or missing cooldown is not invented as a stopped motor', async t => {
  const f = await fixture(t);
  for (const value of [undefined, -1, 31, '0']) {
    f.push({ 'extend.count_down': value });
    await until(() => !f.backend.snapshot().online);
    await assert.rejects(f.backend.execute({ type: 'mode', mode: 'blow', on: true }));
    f.push({ 'extend.count_down': 0 });
    await until(() => f.backend.snapshot().online);
  }
  assert.equal(f.writes.length, 0);
});

test('HA cooldown polling cannot race an older full snapshot over a light command', async t => {
  const f = await fixture(t);
  await f.backend.refresh();
  f.delayNextRead = 250;
  const reading = f.backend.refresh();
  const setting = f.backend.execute({ type: 'mainLight', on: true });
  await delay(50);
  assert.equal(f.writes.length, 0, 'Finish the earlier read before changing the device');
  await Promise.all([reading, setting]);
  assert.equal(f.backend.snapshot().mainLight, true);
});

test('real HAP dual fans have distinct names and cooldown returns RESOURCE_BUSY with actual run-on state', async t => {
  const f = await fixture(t);
  const require = createRequire(import.meta.url);
  const { HomebridgeAPI } = await import(pathToFileURL(join(dirname(require.resolve('homebridge')), 'api.js')).href);
  const api = new HomebridgeAPI();
  const acc = new api.platformAccessory('奥普 A3-Air', hap.uuid.generate('dual-fan-cooldown-test'));
  const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
  const control = new AupuAccessory(acc, hap, f.backend, log, parseSettings({ platform: 'AupuA3Air', backend: 'ha', ha: f.config }));
  t.after(() => control.close());
  const vent = acc.getServiceById(hap.Service.Fanv2, 'ventilation');
  const blower = acc.getServiceById(hap.Service.Fanv2, 'blower');
  assert.equal(vent.getCharacteristic(hap.Characteristic.ConfiguredName).value, '换气排风');
  assert.equal(blower.getCharacteristic(hap.Characteristic.ConfiguredName).value, '吹风送风');
  f.push({ 'extend.count_down': 20 });
  await until(() => f.backend.snapshot().cooldownSeconds === 20);
  assert.equal(await blower.getCharacteristic(hap.Characteristic.Active).handleGetRequest(), 0);
  assert.equal(await blower.getCharacteristic(hap.Characteristic.CurrentFanState).handleGetRequest(), hap.Characteristic.CurrentFanState.BLOWING_AIR);
  const blocked = [vent.getCharacteristic(hap.Characteristic.Active), blower.getCharacteristic(hap.Characteristic.Active),
    acc.getServiceById(hap.Service.Switch, 'deodorize').getCharacteristic(hap.Characteristic.On)];
  for (const c of blocked) {
    let error;
    try { await c.handleSetRequest(c.UUID === hap.Characteristic.On.UUID ? true : 1); } catch (e) { error = e; }
    assert.equal(error, hap.HAPStatus.RESOURCE_BUSY);
  }
  assert.equal(f.writes.length, 0);
});

test('HA cached zero cannot clear a real cooldown and cached positive cannot resurrect a finished cooldown', async t => {
  const f = await fixture(t);
  f.attrs['extend.count_down'] = 28;
  await f.backend.refresh();
  assert.equal(f.backend.snapshot().cooldownSeconds, 28);
  f.push({ 'extend.count_down': 0 }); // New HA timestamp, stale per-property data.
  await delay(30);
  assert.equal(f.backend.snapshot().cooldownSeconds, 28);
  f.attrs['extend.count_down'] = 26;
  await assert.rejects(f.backend.execute({ type: 'mode', mode: 'blow', on: true }), { code: 'busy' });
  await f.backend.refresh(); // The enqueue guard rejects immediately; explicit reads update the countdown.
  assert.equal(f.backend.snapshot().cooldownSeconds, 26);
  assert.equal(f.writes.length, 0);
  f.attrs['extend.count_down'] = 0;
  await f.backend.refresh();
  f.push({ 'extend.count_down': 7 });
  await delay(30);
  assert.equal(f.backend.snapshot().cooldownSeconds, 0);
  f.attrs['extend.count_down'] = 0;
});

test('HA freshly timestamped cached heat and light cannot undo a confirmed shutdown', async t => {
  const f = await fixture(t);
  Object.assign(f.attrs, { 'ptc_bath_heater.mode': 18, 'light.on': true });
  await f.backend.refresh();
  Object.assign(f.attrs, { 'ptc_bath_heater.mode': 0, 'light.on': false, 'extend.count_down': 28 });
  await f.backend.refresh();
  assert.equal(f.backend.snapshot().mode, 'off');
  assert.equal(f.backend.snapshot().mainLight, false);

  const reported = [];
  f.backend.onState(state => reported.push([state.mode, state.mainLight]));
  const reads = f.backend.diagnostics().reads;
  f.publish({ 'ptc_bath_heater.mode': 18, 'light.on': true, 'extend.count_down': 28 });
  await until(() => f.backend.diagnostics().reads > reads);
  await f.backend.refresh();
  assert.ok(reported.every(([mode, light]) => mode === 'off' && !light), JSON.stringify(reported));
  assert.equal(f.backend.snapshot().cooldownSeconds, 28);
  assert.equal(f.writes.length, 0);
});

test('HA expires a motor request delayed in the queue and reserves pending hot OFF before it executes', async t => {
  const f = await fixture(t);
  await f.backend.refresh();
  f.delayNextRead = 2250;
  const occupied = f.backend.execute({ type: 'targetTemperature', value: 37 });
  await delay(30);
  const late = f.backend.execute({ type: 'mode', mode: 'blow', on: true });
  late.catch(() => {});
  await occupied;
  await assert.rejects(late, { code: 'busy' });
  assert.equal(f.writes.length, 0);
  f.push({ 'ptc_bath_heater.mode': 4 });
  await until(() => f.backend.snapshot().mode === 'dry');
  const stopping = f.backend.execute({ type: 'mode', mode: 'dry', on: false });
  await assert.rejects(f.backend.execute({ type: 'mode', mode: 'dry', on: true }), { code: 'busy' });
  await stopping;
  assert.deepEqual(f.writes.map(w => [w.siid, w.piid, w.value]), [[3, 2, 0]]);
});
