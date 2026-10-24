import os from 'node:os';
import { CliError } from './errors.mjs';

/** Names of non-loopback interfaces that have an address (i.e. look "up"). */
export function upInterfaces() {
  const ifs = os.networkInterfaces();
  return Object.entries(ifs)
    .filter(([, addrs]) => (addrs ?? []).some((a) => !a.internal))
    .map(([name]) => name);
}

/**
 * §10.2: the CLI refuses to run while a network interface is up. `verify` and `audit` accept
 * --allow-network (online support machine, public keys only). --dev-allow-network exists for
 * development and automated tests only and prints a warning.
 */
export function enforceOffline(command, opts) {
  const up = upInterfaces();
  if (up.length === 0) return;
  const readOnly = command === 'verify' || command === 'audit';
  if (readOnly && opts['allow-network']) return;
  if (opts['dev-allow-network']) {
    process.stderr.write(`warning: --dev-allow-network: running "${command}" with network interfaces up (${up.join(', ')}). DEVELOPMENT ONLY — never on the signing machine.\n`);
    return;
  }
  throw new CliError(
    `Refusing to run "${command}": network interface(s) up (${up.join(', ')}). Run on the offline signing machine`
      + (readOnly ? ', or pass --allow-network on the online support machine (public keys only).' : '.'),
    4,
  );
}
