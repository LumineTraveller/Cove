'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function privateAddress(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  if (net.isIP(value) !== 4) return false;
  const parts = value.split('.').map(Number);
  return parts[0] === 127 || parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
function within(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function readConfig(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'acceptance.config.json'), 'utf8'));
  if (config.flavor !== 'cove-acceptance-20261023') throw new Error('Not a Cove acceptance package');
  for (const name of ['httpPort', 'mediaPort'])
    if (!Number.isInteger(config[name]) || config[name] < 1024 || config[name] > 65535)
      throw new Error(`Invalid acceptance ${name}`);
  if (!privateAddress(config.announceAddress)) throw new Error('Use an explicit local/LAN IP for acceptance; public servers are blocked');
  if (config.listenHost !== '127.0.0.1' && config.listenHost !== '0.0.0.0')
    throw new Error('listenHost must be 127.0.0.1 or explicit LAN opt-in 0.0.0.0');
  const state = path.join(root, 'acceptance-data');
  fs.mkdirSync(state, { recursive: true });
  if (!within(fs.realpathSync(root), fs.realpathSync(state))) throw new Error('Acceptance state must stay in this portable folder');
  return { ...config, state };
}
function cleanRuntimeEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_FORCE_IS_PACKAGED',
    'MEDIASOUP_WORKER_BIN', 'MEDIASOUP_USE_VALGRIND', 'MEDIASOUP_BUILDTYPE']) delete clean[name];
  return clean;
}
module.exports = { privateAddress, within, readConfig, cleanRuntimeEnvironment };
