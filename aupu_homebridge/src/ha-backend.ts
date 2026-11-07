import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceError, validateCommand, assertModeStartAllowed, requestedMode } from './backend.js';
import type { DeviceBackend, DeviceCommand, DeviceState, FanSpeed, OperatingMode } from './backend.js';
import { HaClient } from './ha-client.js';
import type { HaConfig, HaField } from './ha-contract.js';

export interface HaState { entity_id: string; state: string; attributes: Record<string, any>; last_updated: string }

export function decodeHaState(attributes: Record<string, any>, config: HaConfig): DeviceState {
  const read = (key: keyof HaConfig['fields']): unknown => attributes[config.fields[key].attribute];
  const number = (key: keyof HaConfig['fields'], min: number, max: number): number => {
    const v = read(key);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new DeviceError('offline', 'Invalid device data');
    return v;
  };
  const boolean = (key: 'mainLight' | 'nightLight'): boolean => {
    const v = read(key);
    if (typeof v !== 'boolean') throw new DeviceError('offline', 'Missing light state');
    return v;
  };
  const rawMode = number('mode', 0, 65535);
  const fault = number('fault', 0, 65535);
  const speed = number('fanSpeed', 1, 5);
  const blowerSpeed = number('blowerSpeed', 1, 5);
  const cooldownSeconds = number('cooldownSeconds', 0, 30);
  if (![rawMode, fault, speed, blowerSpeed, cooldownSeconds].every(Number.isInteger)) throw new DeviceError('offline', 'Invalid device enumeration');
  let mode: OperatingMode = 'other';
  for (const [key, code] of Object.entries(config.modes)) if (rawMode === code) mode = key as OperatingMode;
  mode = config.modeAliases[String(rawMode)] ?? mode;
  const target = number('targetTemperature', config.temperature.min, config.temperature.max);
  validateCommand({ type: 'targetTemperature', value: target }, config.temperature);
  return {
    online: true, mainLight: boolean('mainLight'), nightLight: boolean('nightLight'), mode, rawMode, fault,
    currentTemperature: number('currentTemperature', 0, 100), targetTemperature: target, fanSpeed: speed as FanSpeed,
    blowerSpeed: blowerSpeed as FanSpeed, cooldownSeconds,
    // The device reports its operating mode, not the instantaneous PTC element power.
    heating: mode === 'heat' && fault === 0,
  };
}

function checkResponse(value: unknown): void {
  if (value === false) throw new DeviceError('offline', 'Device rejected command');
  if (Array.isArray(value)) { for (const item of value) checkResponse(item); }
  else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (('code' in v && v.code !== 0) || v.success === false) throw new DeviceError('offline', 'Device rejected command');
    for (const item of Object.values(v)) if (item && typeof item === 'object') checkResponse(item);
  }
}

export class HaBackend implements DeviceBackend {
  readonly temperatureRange;
  private readonly client: HaClient;
  private readonly events = new EventEmitter();
  private state: DeviceState;
  private stopped = false;
  private connected = false;
  private initializing = false;
  private buffered: HaState[] = [];
  private lastHaTimestamp = 0;
  private lastFresh = 0;
  private lastDirectReadAt = 0;
  private stopGuardUntil = 0;
  private pendingHotStops = 0;
  private queue: Promise<void> = Promise.resolve();
  private lightTail?: { command: Extract<DeviceCommand, { type: 'mainLight' | 'nightLight' }>; generation: number; promise: Promise<void> };
  private readonly watchdog: NodeJS.Timeout;
  private reads = 0;
  private writes = 0;
  private refreshing?: Promise<void>;
  private cooldownPoll?: NodeJS.Timeout;
  private stateRefreshNeeded = false;
  private executing = false;

  constructor(private readonly config: HaConfig, private readonly status: (message: string) => void = () => {}) {
    this.temperatureRange = config.temperature;
    this.state = { online: false, mainLight: false, nightLight: false, mode: 'off', currentTemperature: 0,
      targetTemperature: config.temperature.min, fanSpeed: 1, blowerSpeed: 1, cooldownSeconds: 0, heating: false, fault: 0 };
    this.client = new HaClient(config);
    this.client.on('authenticated', () => { void this.initialize(); });
    this.client.on('disconnected', () => { this.connected = false; this.initializing = false; this.offline(); });
    this.client.on('status', () => this.status('HA connection unavailable'));
    this.client.on('event', (event: any) => {
      if (event?.event_type !== 'state_changed' || event.data?.entity_id !== config.informationEntity) return;
      const state = event.data.new_state as HaState | null;
      if (!state) { this.offline(); return; }
      if (this.initializing) this.buffered.push(state);
      else this.applyEvent(state);
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFresh > config.staleSeconds * 1000) this.offline();
    }, 1000);
    this.watchdog.unref();
    this.client.start();
  }

  snapshot(): Readonly<DeviceState> { return { ...this.state }; }
  diagnostics(): { connected: boolean; reads: number; writes: number; readOnly: boolean } {
    return { connected: this.connected, reads: this.reads, writes: this.writes, readOnly: this.config.readOnly };
  }
  onState(listener: (state: Readonly<DeviceState>) => void): () => void {
    this.events.on('state', listener); return () => this.events.off('state', listener);
  }
  close(): void {
    this.stopped = true; clearInterval(this.watchdog); clearTimeout(this.cooldownPoll); this.client.close(); this.events.removeAllListeners();
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const run = this.readFresh();
    this.refreshing = run;
    void run.finally(() => { if (this.refreshing === run) this.refreshing = undefined; }).catch(() => {});
    return run;
  }

  private async readFresh(): Promise<void> {
    if (!this.connected) throw new DeviceError('offline', 'HA disconnected');
    const started = Date.now();
    this.reads++;
    const result = await this.service('get_properties', {
      mapping: Object.values(this.config.fields).map(({ siid, piid }) => ({ siid, piid })), update_entity: false,
    });
    checkResponse(result);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new DeviceError('offline', 'Missing device readback');
    const actual = decodeHaState(result as Record<string, unknown>, this.config);
    this.stateRefreshNeeded = false;
    this.apply(actual);
    this.lastDirectReadAt = Math.max(this.lastDirectReadAt, started);
    this.lastFresh = Date.now();
  }

  private async readLight(key: 'mainLight' | 'nightLight'): Promise<void> {
    const started = Date.now();
    const { siid, piid, attribute } = this.config.fields[key];
    this.reads++;
    const result = await this.service('get_properties', { mapping: [{ siid, piid }], update_entity: false });
    checkResponse(result);
    if (typeof result?.[attribute] !== 'boolean') throw new DeviceError('offline', 'Missing light readback');
    this.apply({ ...this.state, [key]: result[attribute] });
    this.lastDirectReadAt = Math.max(this.lastDirectReadAt, started);
    // A single light read must not refresh the freshness of temperature/fault/mode data.
  }

  execute(command: DeviceCommand): Promise<void> {
    try {
      validateCommand(command, this.temperatureRange);
      if (this.config.readOnly) throw new DeviceError('readonly', 'Read-only mode');
      if (!this.connected || !this.state.online || this.stopped) throw new DeviceError('offline', 'Device offline');
      assertModeStartAllowed(this.state, command);
      if (requestedMode(command) && (this.pendingHotStops > 0 || Date.now() < this.stopGuardUntil)) {
        throw new DeviceError('busy', 'A heating/drying shutdown is pending');
      }
    } catch (error) { return Promise.reject(error); }
    const generation = this.client.generation;
    const light = command.type === 'mainLight' || command.type === 'nightLight';
    if (light && this.lightTail?.command.type === command.type && this.lightTail.generation === generation) {
      this.lightTail.command.on = command.on;
      return this.lightTail.promise;
    }
    const queued = { ...command };
    const queuedAt = Date.now();
    const hotStop = command.type === 'mode' && !command.on && command.mode === this.state.mode
      && ['heat', 'dry'].includes(this.state.mode);
    if (hotStop) this.pendingHotStops++;
    const run = this.queue.catch(() => {}).then(async () => {
      if (this.lightTail?.command === queued) this.lightTail = undefined;
      const start = Date.now();
      this.executing = true;
      try {
        if (this.stopped || !this.connected || generation !== this.client.generation) throw new DeviceError('offline', 'Session changed');
        // Never turn an old queued motor request into a delayed automatic startup.
        if (requestedMode(queued) && Date.now() - queuedAt > 2000) throw new DeviceError('busy', 'Motor start request expired in queue');
        if (this.refreshing) await this.refreshing;
        await this.executeOne(queued);
        this.status(`Command ${queued.type} confirmed (${Date.now() - start} ms)`);
      } finally {
        if (hotStop) this.pendingHotStops--;
        this.executing = false;
      }
    });
    this.lightTail = light ? { command: queued as Extract<DeviceCommand, { type: 'mainLight' | 'nightLight' }>, generation, promise: run } : undefined;
    this.queue = run;
    return run;
  }

  private async initialize(): Promise<void> {
    const generation = this.client.generation;
    this.initializing = true; this.buffered = []; this.lastHaTimestamp = 0;
    try {
      await this.client.request('subscribe_events', { event_type: 'state_changed' });
      const states = await this.client.request('get_states') as HaState[];
      if (generation !== this.client.generation || this.stopped) return;
      const state = states.find(s => s.entity_id === this.config.informationEntity);
      if (state) this.applyEvent(state);
      for (const event of this.buffered) this.applyEvent(event);
      this.buffered = []; this.initializing = false; this.connected = true;
      await this.refresh(); // A read only: never restore or replay a requested mode on connection.
      this.status('HA state synchronized');
    } catch {
      this.initializing = false; this.offline(); this.status('HA state unavailable');
      if (!this.connected) this.client.disconnect();
    }
  }

  private applyEvent(state: HaState): void {
    const time = Date.parse(state.last_updated);
    if (!Number.isFinite(time) || time < this.lastHaTimestamp) return;
    this.lastHaTimestamp = time;
    const a = state.attributes;
    if (a.available === false || state.state === 'unavailable') { this.offline(); return; }
    if (a.updater === 'none') return; // Integration's temporary/optimistic update is not a confirmed read.
    const measured = Date.parse(a.updated_at);
    if (a.updater !== 'local' || !Number.isFinite(measured)
      || Date.now() - measured > this.config.staleSeconds * 1000 || measured - Date.now() > 30000) {
      this.offline(); return;
    }
    if (measured < this.lastDirectReadAt) return; // Late polling results must not roll back a newer direct read.
    try {
      const decoded = decodeHaState(a, this.config);
      // A new info timestamp can carry stale switch, mode, and countdown values.
      // Confirm switch and mode transitions with a direct read before publishing them.
      if (!this.state.online || decoded.rawMode !== this.state.rawMode
        || decoded.mainLight !== this.state.mainLight || decoded.nightLight !== this.state.nightLight) {
        this.stateRefreshNeeded = true;
        this.apply(this.state);
        return;
      }
      if (decoded.cooldownSeconds !== this.state.cooldownSeconds) this.stateRefreshNeeded = true;
      decoded.cooldownSeconds = this.state.cooldownSeconds;
      this.apply(decoded); this.lastFresh = measured;
    } catch { this.offline(); }
  }

  private async service(name: string, data: Record<string, unknown>): Promise<any> {
    const response = await this.client.request('call_service', {
      domain: 'xiaomi_miot', service: name,
      service_data: { entity_id: this.config.controlEntity, ...data }, return_response: true,
    });
    return response?.response;
  }

  private async write(field: HaField, value: number | boolean): Promise<void> {
    this.writes++;
    checkResponse(await this.service('set_miot_property', { siid: field.siid, piid: field.piid, value, throw: true }));
  }

  private async executeOne(command: DeviceCommand): Promise<void> {
    // Fresh device read before every operation also protects against delayed old-mode OFFs.
    const light = command.type === 'mainLight' || command.type === 'nightLight';
    if (light) await this.readLight(command.type);
    else await this.refresh();
    const s = this.state;
    const f = this.config.fields;
    let verify: (state: DeviceState) => boolean;
    if (command.type === 'mainLight' || command.type === 'nightLight') {
      if (s[command.type] === command.on) return;
      await this.write(f[command.type], command.on);
      verify = state => state[command.type] === command.on;
    } else {
      assertModeStartAllowed(s, command);
      if (requestedMode(command) && Date.now() < this.stopGuardUntil) {
        throw new DeviceError('busy', 'Waiting for factory shutdown feedback');
      }
      if (s.fault) throw new DeviceError('offline', 'Device fault blocks motor/heater commands');
      if (command.type === 'targetTemperature') {
        if (s.targetTemperature === command.value) return;
        await this.write(f.targetTemperature, command.value);
        verify = state => state.targetTemperature === command.value;
      } else if (command.type === 'mode') {
        if (!command.on && s.mode === 'other') throw new DeviceError('offline', 'Unrepresented device mode');
        if (command.on ? s.mode === command.mode : s.mode !== command.mode) return;
        const code = command.on ? this.config.modes[command.mode] : this.config.modes.off;
        if (!command.on && ['heat', 'dry'].includes(s.mode)) this.stopGuardUntil = Date.now() + 2000;
        await this.write(f.mode, code);
        verify = state => state.rawMode === code;
      } else {
        const mode = command.type === 'fanSpeed' ? 'vent' : 'blow';
        const key = command.type === 'fanSpeed' ? 'fanSpeed' : 'blowerSpeed';
        if (!command.value) {
          if (s.mode === 'other') throw new DeviceError('offline', 'Unrepresented device mode');
          if (s.mode !== mode) return;
          await this.write(f.mode, this.config.modes.off);
          verify = state => state.mode === 'off';
        } else {
          if (s[key] !== command.value) await this.write(f[key], command.value);
          if (s.mode !== mode) await this.write(f.mode, this.config.modes[mode]);
          verify = state => state.mode === mode && state[key] === command.value;
        }
      }
    }
    // Re-read only; ambiguous writes are never retried automatically.
    for (let i = 0; i < 3; i++) {
      if (i || light) await delay(light ? 250 : 200); // The light's ACK can precede the physical state change.
      if (light) await this.readLight(command.type);
      else await this.refresh();
      if (verify(this.state)) return;
    }
    throw new DeviceError('offline', 'Device did not confirm requested state');
  }

  private apply(state: DeviceState): void {
    if (['heat', 'dry'].includes(this.state.mode) && state.mode !== this.state.mode) {
      this.stopGuardUntil = Date.now() + 2000;
    }
    const poll = this.connected && (this.stateRefreshNeeded
      || (state.online && (state.cooldownSeconds > 0 || Date.now() < this.stopGuardUntil)));
    if (poll && !this.cooldownPoll && !this.stopped) {
      this.cooldownPoll = setTimeout(() => {
        this.cooldownPoll = undefined;
        if (this.stopped) return;
        if (this.executing) { this.apply(this.state); return; }
        void this.refresh().catch(() => this.offline());
      }, 1500);
      this.cooldownPoll.unref();
    } else if (!poll) { clearTimeout(this.cooldownPoll); this.cooldownPoll = undefined; }
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state; this.events.emit('state', this.snapshot());
  }
  private offline(): void {
    this.stateRefreshNeeded = false;
    if (this.state.online) this.apply({ ...this.state, online: false });
  }
}
