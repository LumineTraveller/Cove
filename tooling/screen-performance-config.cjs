'use strict';

function validatePerformanceCases(cases) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 12)
    throw Error('Performance cases must be a bounded nonempty array');
  for (const config of cases) {
    if (!config || typeof config !== 'object' || !['generated', 'native'].includes(config.source) ||
        !['540p', '720p', '1080p', '1440p'].includes(config.preset) || ![30, 60, 120].includes(config.fps))
      throw Error('Invalid performance case');
    for (const [width, height] of [['expectWidth', 'expectHeight'],
      ['expectCaptureWidth', 'expectCaptureHeight'], ['expectEncodedWidth', 'expectEncodedHeight']]) {
      if (config[width] === undefined && config[height] === undefined) continue;
      if (![config[width], config[height]].every(value => typeof value === 'number' &&
          Number.isInteger(value) && value > 0 && value <= 8192))
        throw Error(`${width}/${height} must be paired positive integer dimensions`);
    }
    if (config.expectCodec !== undefined && !['video/VP8', 'video/AV1'].includes(config.expectCodec))
      throw Error('Unsupported comparison codec');
  }
  return cases;
}

module.exports = { validatePerformanceCases };
