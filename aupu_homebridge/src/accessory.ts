import type { Characteristic, CharacteristicValue, HAP, Logging, PlatformAccessory, Service } from 'homebridge';

import { DeviceError } from './backend.js';
import type { DeviceBackend, DeviceCommand, DeviceState } from './backend.js';
import type { Settings } from './config.js';
import { percentToSpeed, requireBoolean, requireNumber, speedToPercent } from './mapping.js';

type ServiceConstructor = HAP['Service']['Lightbulb'];
type Binding = { characteristic: Characteristic; read: (state: Readonly<DeviceState>) => CharacteristicValue };

function modeIs(state: Readonly<DeviceState>, mode: string): boolean {
  if (state.mode === 'other' || state.fault) throw new DeviceError('offline', 'Unrepresented or faulted work mode');
  return state.mode === mode;
}

export class AupuAccessory {
  private readonly bindings: Binding[] = [];
  private readonly unsubscribe: () => void;
  private readonly identify: () => void;
  private refresh?: NodeJS.Immediate;

  constructor(
    private readonly accessory: PlatformAccessory,
    private readonly hap: HAP,
    private readonly backend: DeviceBackend,
    private readonly log: Logging,
    settings: Settings,
  ) {
    const { Service: S, Characteristic: C } = hap;
    const information = accessory.getService(S.AccessoryInformation)!;
    // Keep existing manufacturer/model/serial stable across the simulation -> HA migration.
    if (!information.getCharacteristic(C.SerialNumber).value || information.getCharacteristic(C.SerialNumber).value === 'Default-SerialNumber') {
      information.setCharacteristic(C.Manufacturer, 'Virtual Aupu Lab').setCharacteristic(C.Model, 'A3-Air Simulator')
        .setCharacteristic(C.SerialNumber, settings.deviceId);
    }
    information.setCharacteristic(C.FirmwareRevision, '0.3.2');

    const main = this.service(S.Lightbulb, '主照明', 'main-light');
    const night = this.service(S.Lightbulb, '小夜灯', 'night-light');
    const heater = this.service(S.HeaterCooler, 'AI 恒温取暖', 'heater');
    const fan = this.service(S.Fanv2, '换气排风', 'ventilation');
    const blower = this.service(S.Fanv2, '吹风送风', 'blower');
    const dry = this.service(S.Switch, '干燥', 'dry');
    const deodorize = this.service(S.Switch, '铂金除臭', 'deodorize');
    // Primary describes the main function; it is not an Apple Home layout command.
    for (const service of accessory.services) service.setPrimaryService(false);
    const primary = { heater, fan, light: main }[settings.primaryService];
    primary.setPrimaryService(true);
    primary.setCharacteristic(C.Name, settings.name);

    this.bind(main.getCharacteristic(C.On), s => s.mainLight, v => ({ type: 'mainLight', on: requireBoolean(v) }));
    this.bind(night.getCharacteristic(C.On), s => s.nightLight, v => ({ type: 'nightLight', on: requireBoolean(v) }));
    this.bind(heater.getCharacteristic(C.Active), s => Number(modeIs(s, 'heat')),
      v => ({ type: 'mode', mode: 'heat', on: requireBoolean(v) }));
    this.bind(heater.getCharacteristic(C.CurrentTemperature), s => s.currentTemperature);
    this.bind(heater.getCharacteristic(C.CurrentHeaterCoolerState), s => !modeIs(s, 'heat')
      ? C.CurrentHeaterCoolerState.INACTIVE
      : s.heating ? C.CurrentHeaterCoolerState.HEATING : C.CurrentHeaterCoolerState.IDLE);
    this.bind(heater.getCharacteristic(C.TargetHeaterCoolerState)
      .updateValue(C.TargetHeaterCoolerState.HEAT)
      .setProps({ validValues: [C.TargetHeaterCoolerState.HEAT] }),
    () => C.TargetHeaterCoolerState.HEAT, v => {
      if (v !== C.TargetHeaterCoolerState.HEAT) throw new DeviceError('invalid', 'Heating only; no cooling or auto mode');
      // Target mode and Active are separate in HAP. Selecting HEAT alone does not start heating.
    });
    this.bind(heater.getCharacteristic(C.HeatingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 100 })
      .updateValue(backend.snapshot().targetTemperature)
      .setProps({ minValue: backend.temperatureRange.min, maxValue: backend.temperatureRange.max, minStep: backend.temperatureRange.step }),
    s => s.targetTemperature, v => ({ type: 'targetTemperature', value: requireNumber(v) }));

    this.bind(fan.getCharacteristic(C.Active), s => Number(modeIs(s, 'vent')),
      v => ({ type: 'mode', mode: 'vent', on: requireBoolean(v) }));
    this.bind(fan.getCharacteristic(C.CurrentFanState), s => modeIs(s, 'vent')
      ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE);
    this.bind(fan.getCharacteristic(C.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 20 }),
      s => { modeIs(s, 'vent'); return speedToPercent(s); }, v => ({ type: 'fanSpeed', value: percentToSpeed(v) }));
    this.bind(blower.getCharacteristic(C.Active), s => Number(modeIs(s, 'blow')),
      v => ({ type: 'mode', mode: 'blow', on: requireBoolean(v) }));
    this.bind(blower.getCharacteristic(C.CurrentFanState), s => {
      modeIs(s, 'blow');
      return s.mode === 'blow' || s.cooldownSeconds > 0 ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE;
    });
    this.bind(blower.getCharacteristic(C.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 20 }),
      s => { modeIs(s, 'blow'); return speedToPercent(s, 'blow'); }, v => ({ type: 'blowerSpeed', value: percentToSpeed(v) }));
    this.bind(dry.getCharacteristic(C.On), s => modeIs(s, 'dry'),
      v => ({ type: 'mode', mode: 'dry', on: requireBoolean(v) }));
    this.bind(deodorize.getCharacteristic(C.On), s => modeIs(s, 'deodorize'),
      v => ({ type: 'mode', mode: 'deodorize', on: requireBoolean(v) }));

    const oldSensor = accessory.getServiceById(S.TemperatureSensor, 'temperature');
    if (settings.includeTemperatureSensor) {
      const temperature = this.service(S.TemperatureSensor, '环境温度', 'temperature');
      this.bind(temperature.getCharacteristic(C.CurrentTemperature), s => s.currentTemperature);
      this.bind(temperature.getCharacteristic(C.StatusFault), s => Number(s.fault !== 0));
    } else if (oldSensor) {
      accessory.removeService(oldSensor);
    }
    this.identify = () => this.log.info('[%s] 识别奥普 A3-Air', settings.backend);
    accessory.on('identify', this.identify);
    this.unsubscribe = backend.onState(state => {
      this.pushState(state);
      this.log.info('[%s 状态] %s', settings.backend, JSON.stringify(state));
    });
    this.pushState(backend.snapshot());
  }

  close(): void {
    this.unsubscribe();
    if (this.refresh) clearImmediate(this.refresh);
    this.accessory.removeListener('identify', this.identify);
    this.backend.close();
  }

  private service(type: ServiceConstructor, name: string, subtype: string): Service {
    const service = this.accessory.getServiceById(type, subtype)
      ?? this.accessory.addService(new type(name, subtype));
    service.displayName = name;
    service.setCharacteristic(this.hap.Characteristic.Name, name);
    // Apple Home can label same-type children generically even when Name is present.
    // Publish the standard writable ConfiguredName, preserving subsequent user renames.
    const C = this.hap.Characteristic;
    if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
    const configuredName = service.getCharacteristic(C.ConfiguredName);
    if (!configuredName.value || (subtype === 'ventilation' && ['换气', '风扇'].includes(String(configuredName.value)))) {
      configuredName.updateValue(name);
    }
    return service;
  }

  private bind(
    characteristic: Characteristic,
    read: Binding['read'],
    command?: (value: CharacteristicValue) => DeviceCommand | void,
  ): void {
    this.bindings.push({ characteristic, read });
    characteristic.onGet(() => {
      const state = this.backend.snapshot();
      if (!state.online) throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      try { return read(state); } catch { throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
    });
    if (command) {
      characteristic.onSet(async (value, _context, connection) => {
        try {
          if (!this.backend.snapshot().online) throw new DeviceError('offline', 'Device offline');
          const next = command(value);
          this.log.info('[HomeKit 请求] %s；来源=%s', JSON.stringify(next ?? { characteristic: characteristic.displayName, value }),
            connection?.remoteAddress ?? 'unknown');
          if (next) await this.backend.execute(next);
          // HAP stores each incoming value after this handler resolves. A Home scene can
          // write competing modes concurrently; refresh once after those SETs settle.
          if (!this.refresh) this.refresh = setImmediate(() => {
            this.refresh = undefined;
            this.pushState(this.backend.snapshot());
          });
          this.log.info('[HomeKit 操作] %s = %s', characteristic.displayName, String(value));
        } catch (error) {
          const invalid = error instanceof DeviceError && error.code === 'invalid';
          const busy = error instanceof DeviceError && error.code === 'busy';
          // Log a category only: future backend exceptions may contain credentials/URLs.
          this.log.warn('控制失败：%s', busy ? `正在停机散热，设备倒计时 ${this.backend.snapshot().cooldownSeconds} 秒` : invalid ? '无效参数' : '设备通信异常');
          throw new this.hap.HapStatusError(invalid
            ? this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST
            : busy ? this.hap.HAPStatus.RESOURCE_BUSY : error instanceof DeviceError && error.code === 'readonly'
              ? this.hap.HAPStatus.READ_ONLY_CHARACTERISTIC : this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
    }
  }

  private pushState(state: Readonly<DeviceState>): void {
    for (const { characteristic, read } of this.bindings) {
      try {
        if (!state.online) throw new Error('Offline');
        characteristic.updateValue(read(state));
      } catch { characteristic.updateValue(new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)); }
    }
  }
}
