import { DeviceError } from './backend.js';
import type { DeviceState, FanSpeed } from './backend.js';

/** HomeKit's 0–100% control is quantized to OFF and five speeds. */
export function percentToSpeed(value: unknown): 0 | FanSpeed {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new DeviceError('invalid', 'Fan percentage must be 0–100');
  }
  return value === 0 ? 0 : Math.max(1, Math.round(value / 20)) as FanSpeed;
}

export function speedToPercent(state: Readonly<DeviceState>, mode: 'vent' | 'blow' = 'vent'): number {
  return state.mode === mode ? (mode === 'vent' ? state.fanSpeed : state.blowerSpeed) * 20 : 0;
}

export function requireBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  // Active is a HAP uint8, while On is a HAP bool.
  if (value === 0 || value === 1) return value === 1;
  throw new DeviceError('invalid', 'Expected a boolean or Active 0/1');
}

export function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeviceError('invalid', 'Expected a finite number');
  }
  return value;
}
