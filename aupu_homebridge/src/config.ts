import type { PlatformConfig } from 'homebridge';
import { parseHaConfig } from './ha-contract.js';
import type { HaConfig } from './ha-contract.js';

export interface Settings {
  backend: 'simulation' | 'ha';
  ha?: HaConfig;
  name: string;
  deviceId: string;
  primaryService: 'heater' | 'fan' | 'light';
  includeTemperatureSensor: boolean;
  simulation: { ambientTemperature: number; targetTemperature: number; tickSeconds: number };
}

export function parseSettings(config: PlatformConfig): Settings {
  const backend = config.backend ?? 'simulation';
  if (!['simulation', 'ha'].includes(backend)) throw new Error('Unsupported backend');
  const simulation = config.simulation ?? {};
  if (typeof simulation !== 'object' || simulation === null || Array.isArray(simulation)) {
    throw new Error('simulation must be an object');
  }
  const text = (value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new Error('Invalid name or deviceId');
    return value.trim();
  };
  const number = (value: unknown, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Simulation numeric setting must be between ${min} and ${max}`);
    }
    return value;
  };
  const primaryService = config.primaryService ?? 'heater';
  if (!['heater', 'fan', 'light'].includes(primaryService)) throw new Error('Invalid primaryService');
  if (config.includeTemperatureSensor !== undefined && typeof config.includeTemperatureSensor !== 'boolean') {
    throw new Error('includeTemperatureSensor must be boolean');
  }
  const targetTemperature = number(simulation.targetTemperature, 28, 16, 40);
  if (!Number.isInteger(targetTemperature * 2)) throw new Error('Target temperature step must be 0.5°C');
  return {
    backend,
    ha: backend === 'ha' ? parseHaConfig(config.ha) : undefined,
    name: text(config.name, '奥普 A3-Air'),
    deviceId: text(config.deviceId, 'aupu-a3-air-virtual-1'),
    primaryService,
    includeTemperatureSensor: config.includeTemperatureSensor ?? true,
    simulation: {
      ambientTemperature: number(simulation.ambientTemperature, 24, 0, 50),
      targetTemperature,
      tickSeconds: number(simulation.tickSeconds, 5, 1, 60),
    },
  };
}
