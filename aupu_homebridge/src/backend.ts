/** Backend boundary shared by the simulator and the local HA adapter. */
export type OperatingMode = 'off' | 'heat' | 'vent' | 'blow' | 'dry' | 'deodorize' | 'other';
export type ControllableMode = Exclude<OperatingMode, 'off' | 'other'>;
export type FanSpeed = 1 | 2 | 3 | 4 | 5;
export interface TemperatureRange { min: number; max: number; step: number }

export interface DeviceState {
  online: boolean;
  mainLight: boolean;
  nightLight: boolean;
  mode: OperatingMode;
  currentTemperature: number;
  targetTemperature: number;
  fanSpeed: FanSpeed;
  blowerSpeed: FanSpeed;
  cooldownSeconds: number;
  heating: boolean;
  fault: number;
  rawMode?: number;
}

export type DeviceCommand =
  | { type: 'mainLight'; on: boolean }
  | { type: 'nightLight'; on: boolean }
  | { type: 'mode'; mode: ControllableMode; on: boolean }
  | { type: 'targetTemperature'; value: number }
  | { type: 'fanSpeed'; value: 0 | FanSpeed }
  | { type: 'blowerSpeed'; value: 0 | FanSpeed };

export class DeviceError extends Error {
  constructor(public readonly code: 'invalid' | 'offline' | 'readonly' | 'busy', message: string) {
    super(message);
    this.name = 'DeviceError';
  }
}

export interface DeviceBackend {
  readonly temperatureRange: TemperatureRange;
  snapshot(): Readonly<DeviceState>;
  execute(command: DeviceCommand): Promise<void>;
  onState(listener: (state: Readonly<DeviceState>) => void): () => void;
  close(): void;
}

export const TEMPERATURE = { min: 16, max: 40, step: 0.5 } as const;

export function validateCommand(command: DeviceCommand, range: TemperatureRange = TEMPERATURE): void {
  if (command.type === 'mainLight' || command.type === 'nightLight' || command.type === 'mode') {
    if (typeof command.on !== 'boolean') {
      throw new DeviceError('invalid', 'on must be a boolean');
    }
    if (command.type === 'mode' && !['heat', 'vent', 'blow', 'dry', 'deodorize'].includes(command.mode)) {
      throw new DeviceError('invalid', 'Unknown operating mode');
    }
  } else if (command.type === 'targetTemperature') {
    const steps = (command.value - range.min) / range.step;
    if (!Number.isFinite(command.value) || command.value < range.min || command.value > range.max
      || Math.abs(steps - Math.round(steps)) > 0.00001) {
      throw new DeviceError('invalid', 'Target temperature outside the configured device range');
    }
  } else if (command.type === 'fanSpeed' || command.type === 'blowerSpeed') {
    if (!Number.isInteger(command.value) || command.value < 0 || command.value > 5) {
      throw new DeviceError('invalid', 'Fan speed must be an integer from 0 to 5');
    }
  } else {
    throw new DeviceError('invalid', 'Unsupported command');
  }
}

export function requestedMode(command: DeviceCommand): ControllableMode | undefined {
  if (command.type === 'mode' && command.on) return command.mode;
  if (command.type === 'fanSpeed' && command.value > 0) return 'vent';
  if (command.type === 'blowerSpeed' && command.value > 0) return 'blow';
  return undefined;
}

/** Factory cooldown is independent of the requested operating mode and saved fan gears. */
export function assertModeStartAllowed(state: Readonly<DeviceState>, command: DeviceCommand): void {
  const mode = requestedMode(command);
  if (mode && state.mode === 'other') throw new DeviceError('offline', 'Unknown current operating mode');
  if (mode && (state.cooldownSeconds > 0 || (['heat', 'dry'].includes(state.mode) && state.mode !== mode))) {
    throw new DeviceError('busy', 'Stop heating/drying and wait for the factory cooldown to finish');
  }
}
