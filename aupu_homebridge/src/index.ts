import type { API } from 'homebridge';
import { AupuPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export default function register(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AupuPlatform);
}
