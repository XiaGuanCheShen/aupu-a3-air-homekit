import { EventEmitter } from 'node:events';

import { DeviceError, TEMPERATURE, validateCommand, assertModeStartAllowed } from './backend.js';
import type { DeviceBackend, DeviceCommand, DeviceState } from './backend.js';

export class SimulatedBackend implements DeviceBackend {
  readonly temperatureRange = TEMPERATURE;
  private readonly events = new EventEmitter();
  private readonly state: DeviceState;
  private readonly timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly ambientTemperature = 24, private readonly tickSeconds = 5, targetTemperature = 28) {
    if (!Number.isFinite(ambientTemperature) || ambientTemperature < 0 || ambientTemperature > 50
      || !Number.isFinite(tickSeconds) || tickSeconds < 0 || tickSeconds > 60) {
      throw new DeviceError('invalid', 'Invalid simulation temperature or tick interval');
    }
    validateCommand({ type: 'targetTemperature', value: targetTemperature });
    this.state = {
      online: true, mainLight: false, nightLight: false, mode: 'off',
      currentTemperature: ambientTemperature, targetTemperature, fanSpeed: 3, blowerSpeed: 3, cooldownSeconds: 0, heating: false, fault: 0,
    };
    if (tickSeconds > 0) {
      this.timer = setInterval(() => this.tick(), tickSeconds * 1000);
      this.timer.unref();
    }
  }

  snapshot(): Readonly<DeviceState> {
    return { ...this.state };
  }

  onState(listener: (state: Readonly<DeviceState>) => void): () => void {
    this.events.on('state', listener);
    return () => this.events.off('state', listener);
  }

  async execute(command: DeviceCommand): Promise<void> {
    if (this.closed || !this.state.online) {
      throw new DeviceError('offline', 'Simulated device is offline');
    }
    validateCommand(command);
    assertModeStartAllowed(this.state, command);
    this.change(() => {
      switch (command.type) {
        case 'mainLight': case 'nightLight':
          this.state[command.type] = command.on;
          break;
        case 'mode':
          if (command.on) {
            this.state.mode = command.mode;
          } else if (this.state.mode === command.mode) {
            // A late OFF for the old mode must not turn off the newly selected mode.
            if (['heat', 'dry'].includes(this.state.mode)) this.state.cooldownSeconds = 30;
            this.state.mode = 'off';
          }
          break;
        case 'targetTemperature':
          this.state.targetTemperature = command.value;
          break;
        case 'fanSpeed': case 'blowerSpeed': {
          const mode = command.type === 'fanSpeed' ? 'vent' : 'blow';
          const key = command.type === 'fanSpeed' ? 'fanSpeed' : 'blowerSpeed';
          if (command.value === 0) {
            if (this.state.mode === mode) this.state.mode = 'off';
          } else {
            this.state[key] = command.value;
            this.state.mode = mode;
          }
          break;
        }
      }
      this.updateHeating();
    });
  }

  /** Deterministic accelerated room model, not a model of the real Aupu heater. */
  tick(): void {
    if (this.closed || !this.state.online) return;
    this.change(() => {
      this.state.cooldownSeconds = Math.max(0, this.state.cooldownSeconds - Math.max(1, this.tickSeconds));
      const room = this.state.currentTemperature;
      const next = this.state.heating ? room + 0.2 : room + Math.max(-0.1, Math.min(0.1, this.ambientTemperature - room));
      this.state.currentTemperature = Math.round(Math.max(0, Math.min(60, next)) * 10) / 10;
      this.updateHeating();
    });
  }

  /** Test hook for availability and unsolicited updates; never controls hardware. */
  setOnline(online: boolean): void {
    if (!this.closed) this.change(() => { this.state.online = online; });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.events.removeAllListeners();
  }

  private updateHeating(): void {
    if (this.state.mode !== 'heat') this.state.heating = false;
    else if (this.state.currentTemperature <= this.state.targetTemperature - 0.2) this.state.heating = true;
    else if (this.state.currentTemperature >= this.state.targetTemperature + 0.2) this.state.heating = false;
  }

  private change(update: () => void): void {
    const before = JSON.stringify(this.state);
    update();
    if (before !== JSON.stringify(this.state)) this.events.emit('state', this.snapshot());
  }
}
