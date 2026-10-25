import { CHANNELS, type Channel, type Field } from './channels.js';
import { AdminError } from './errors.js';

export function isChannel(name: unknown): name is Channel {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(CHANNELS, name);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkField(name: string, f: Field, v: unknown): void {
  if (f.type === 'string') {
    if (typeof v !== 'string') throw new AdminError('EINVAL', `${name} must be text.`);
    if (v.length > f.max) throw new AdminError('EINVAL', `${name} is too long (max ${f.max} characters).`);
    if (f.pattern && !f.pattern.test(v)) throw new AdminError('EINVAL', `${name} has an invalid format.`);
    if (f.oneOf && !f.oneOf.includes(v)) throw new AdminError('EINVAL', `${name} must be one of: ${f.oneOf.join(', ')}.`);
  } else if (f.type === 'int') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < f.min || v > f.max) throw new AdminError('EINVAL', `${name} must be a whole number ${f.min}-${f.max}.`);
  } else if (typeof v !== 'boolean') {
    throw new AdminError('EINVAL', `${name} must be true or false.`);
  }
}

/** Validates IPC arguments against the channel schema; returns a fresh object with only known keys. */
export function validateArgs(channel: unknown, args: unknown): Record<string, unknown> {
  if (!isChannel(channel)) throw new AdminError('EINVAL', 'Unknown request.');
  const schema: Readonly<Record<string, Field>> = CHANNELS[channel];
  const a = args === undefined ? {} : args;
  if (!isPlainObject(a)) throw new AdminError('EINVAL', 'Request arguments must be an object.');
  for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(schema, k)) throw new AdminError('EINVAL', `Unexpected field ${k.slice(0, 40)}.`);
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema)) {
    const v = a[k];
    if (v === undefined) {
      if (!f.optional) throw new AdminError('EINVAL', `Missing ${k}.`);
      continue;
    }
    checkField(k, f, v);
    out[k] = v;
  }
  return out;
}
