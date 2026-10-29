// Test-only network cut (Entry 35): `node --require poc/e2e/offline-preload.cjs <service.cjs>` makes every outbound TCP connection
// to a non-loopback address fail with ENETUNREACH and every DNS lookup of a non-local name fail with ENOTFOUND, like a laptop
// with Wi-Fi off. Loopback (the Editor, the provider stub) keeps working. Never loaded by product code.
'use strict';
const dns = require('node:dns');
const net = require('node:net');
const local = (h) => !h || h === 'localhost' || /^127\./.test(h) || h === '::1';
const fail = (code, host) => Object.assign(new Error(`${code === 'ENOTFOUND' ? 'getaddrinfo' : 'connect'} ${code} ${host}`), { code, errno: code === 'ENOTFOUND' ? -3008 : -101, syscall: code === 'ENOTFOUND' ? 'getaddrinfo' : 'connect', hostname: host });
const origLookup = dns.lookup;
dns.lookup = function lookup(host, opts, cb) {
  const done = typeof opts === 'function' ? opts : cb;
  if (local(host)) return origLookup.apply(this, arguments);
  process.nextTick(() => done(fail('ENOTFOUND', host)));
  return {};
};
const origPLookup = dns.promises.lookup;
dns.promises.lookup = (host, ...rest) => (local(host) ? origPLookup(host, ...rest) : Promise.reject(fail('ENOTFOUND', host)));
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const o = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : Array.isArray(args[0]) ? args[0][0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  const host = o?.host ?? o?.hostname;
  if (o?.path || local(host)) return origConnect.apply(this, args);
  process.nextTick(() => this.destroy(fail('ENETUNREACH', host)));
  return this;
};
process.stderr.write('[offline-preload] outbound network cut for this process\n');
