'use strict';
const { CLIENT_PROTOCOL_VERSION, CLIENT_RELEASE_VERSIONS } = require('@cove/contracts');

// Smoke clients must satisfy the same version gate as installed clients. Keep
// this derived from the contracts instead of hardcoding an old protocol number.
function smokeClientIdentity(platform = 'desktop') {
  if (platform !== 'desktop' && platform !== 'mobile') throw new Error('Unsupported smoke client platform');
  const version = CLIENT_RELEASE_VERSIONS[platform];
  return {
    headers: {
      'x-cove-client-version': version,
      'x-cove-client-platform': platform,
      'x-cove-client-protocol': String(CLIENT_PROTOCOL_VERSION),
    },
    auth: { clientVersion: version, clientPlatform: platform, clientProtocol: CLIENT_PROTOCOL_VERSION },
    registration: { clientVersion: version, platform },
  };
}

module.exports = { smokeClientIdentity };
