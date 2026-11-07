import { isAbsolute } from 'node:path';
import type { ControllableMode, TemperatureRange } from './backend.js';

export interface HaField { attribute: string; siid: number; piid: number }
export interface HaConfig {
  url: string;
  tokenEnv?: string;
  tokenFile?: string;
  informationEntity: string;
  controlEntity: string;
  fields: Record<'mainLight' | 'nightLight' | 'mode' | 'currentTemperature' | 'targetTemperature' | 'fanSpeed' | 'blowerSpeed' | 'cooldownSeconds' | 'fault', HaField>;
  modes: Record<'off' | ControllableMode, number>;
  modeAliases: Record<string, ControllableMode>;
  temperature: TemperatureRange;
  staleSeconds: number;
  readOnly: boolean;
}

export function parseHaConfig(input: unknown): HaConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ha mapping is required');
  const v = input as Record<string, any>;
  if ('token' in v || 'password' in v) throw new Error('Use tokenFile or tokenEnv, never a literal credential');
  if (typeof v.url !== 'string') throw new Error('HA url is required');
  const url = new URL(v.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('HA URL must be http(s), without credentials or query parameters');
  }
  const { tokenEnv, tokenFile } = v;
  if (!!tokenEnv === !!tokenFile) throw new Error('Choose exactly one tokenEnv or tokenFile');
  if (tokenEnv && (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv))) throw new Error('Invalid tokenEnv');
  if (tokenFile && (typeof tokenFile !== 'string' || !isAbsolute(tokenFile))) throw new Error('tokenFile must be absolute');
  for (const key of ['informationEntity', 'controlEntity']) {
    if (typeof v[key] !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(v[key])) throw new Error(`Invalid ${key}`);
  }
  const fields = {} as HaConfig['fields'];
  for (const key of ['mainLight', 'nightLight', 'mode', 'currentTemperature', 'targetTemperature', 'fanSpeed', 'blowerSpeed', 'cooldownSeconds', 'fault'] as const) {
    const f = v.fields?.[key];
    if (!f || typeof f.attribute !== 'string' || !f.attribute || !Number.isInteger(f.siid) || f.siid < 1
      || !Number.isInteger(f.piid) || f.piid < 1) throw new Error(`Invalid field ${key}`);
    fields[key] = { attribute: f.attribute, siid: f.siid, piid: f.piid };
  }
  const modeKeys = ['off', 'heat', 'vent', 'blow', 'dry', 'deodorize'] as const;
  for (const key of modeKeys) if (!Number.isInteger(v.modes?.[key]) || v.modes[key] < 0) throw new Error(`Missing mode ${key}`);
  if (new Set(modeKeys.map(key => v.modes[key])).size !== modeKeys.length) throw new Error('Modes must have distinct values');
  const aliases = v.modeAliases ?? {};
  for (const [code, mode] of Object.entries(aliases)) {
    if (!/^\d+$/.test(code) || !['heat', 'vent', 'blow', 'dry', 'deodorize'].includes(String(mode))
      || modeKeys.some(key => String(v.modes[key]) === code)) throw new Error('Invalid mode alias');
  }
  const range = v.temperature;
  if (!range || ![range.min, range.max, range.step].every(Number.isFinite)
    || range.min < 0 || range.max > 100 || range.max <= range.min || range.step <= 0 || range.step > range.max - range.min) {
    throw new Error('Invalid real temperature range');
  }
  const staleSeconds = v.staleSeconds ?? 90;
  if (!Number.isFinite(staleSeconds) || staleSeconds < 15 || staleSeconds > 600) throw new Error('Invalid staleSeconds');
  if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') throw new Error('readOnly must be boolean');
  return {
    url: url.href.replace(/\/$/, ''), tokenEnv, tokenFile,
    informationEntity: v.informationEntity, controlEntity: v.controlEntity, fields,
    modes: Object.fromEntries(modeKeys.map(key => [key, v.modes[key]])) as HaConfig['modes'],
    modeAliases: { ...aliases }, temperature: { ...range }, staleSeconds, readOnly: v.readOnly ?? true,
  };
}
