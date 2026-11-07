import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { AupuAccessory } from './accessory.js';
import { parseSettings } from './config.js';
import type { Settings } from './config.js';
import { SimulatedBackend } from './simulator.js';
import { HaBackend } from './ha-backend.js';

export const PLUGIN_NAME = 'homebridge-aupu-a3-air';
export const PLATFORM_NAME = 'AupuA3Air';

export class AupuPlatform implements DynamicPlatformPlugin {
  private readonly settings: Settings;
  private readonly cached: PlatformAccessory[] = [];
  private controller?: AupuAccessory;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    this.settings = parseSettings(config);
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.controller?.close());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  private launch(): void {
    const id = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.settings.deviceId}`);
    const existing = this.cached.find(accessory => accessory.UUID === id);
    const category = {
      heater: this.api.hap.Categories.AIR_HEATER,
      fan: this.api.hap.Categories.FAN,
      light: this.api.hap.Categories.LIGHTBULB,
    }[this.settings.primaryService];
    const accessory = existing ?? new this.api.platformAccessory(this.settings.name, id, category);
    accessory.category = category;
    accessory.updateDisplayName(this.settings.name);
    const simulation = this.settings.simulation;
    const backend = this.settings.backend === 'ha'
      ? new HaBackend(this.settings.ha!, message => this.log.info('[HA] %s', message))
      : new SimulatedBackend(simulation.ambientTemperature, simulation.tickSeconds, simulation.targetTemperature);
    this.controller = new AupuAccessory(accessory, this.api.hap, backend, this.log, this.settings);
    if (this.settings.backend === 'ha') backend.onState(state => {
      if (state.online) this.api.updatePlatformAccessories([accessory]);
    });
    if (existing) this.api.updatePlatformAccessories([accessory]);
    else this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    // Only this platform's old cached virtual accessory is removed if its deviceId changed.
    const stale = this.cached.filter(item => item.UUID !== id);
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    if (this.settings.backend === 'simulation') {
      this.log.info('已注册 1 台虚拟浴霸、%s 个功能服务；模式互斥；真实设备未连接。', accessory.services.length - 1);
    } else {
      this.log.info('已注册 1 台浴霸、%s 个功能服务；HA 实时后端，控制%s。', accessory.services.length - 1,
        this.settings.ha!.readOnly ? '禁用（只读）' : '开启');
    }
  }
}
