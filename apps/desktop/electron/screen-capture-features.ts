const ZERO_COPY_CAPTURE = 'ZeroCopyDesktopCapture';

interface ScreenCaptureFeatureOptions {
  platform: string;
  chromiumVersion: string | undefined;
  enabledFeatures?: string;
  disabledFeatures?: string;
  disableZeroCopy?: boolean;
}

const featureName = (feature: string) => feature.split(/[<:]/, 1)[0];
const featureList = (value = '') => value.split(',').map(item => item.trim()).filter(Boolean);

/** Keep callers' Chromium feature choices; only default the measured Windows path. */
export function screenCaptureFeaturePolicy(options: ScreenCaptureFeatureOptions) {
  let enabled = featureList(options.enabledFeatures);
  const disabled = featureList(options.disabledFeatures);
  if (options.platform !== 'win32') {
    return { enabledFeatures: enabled.join(','), disabledFeatures: disabled.join(',') };
  }

  const has = (list: string[], feature: string) => list.some(item => featureName(item) === feature);
  if (!has(enabled, 'AllowWgcScreenCapturer')) enabled.push('AllowWgcScreenCapturer');

  // Chromium 152 was measured with real display capture, source reacquisition
  // and a GPU-process restart. Revalidate before defaulting future engines.
  if (options.disableZeroCopy) {
    enabled = enabled.filter(item => featureName(item) !== ZERO_COPY_CAPTURE);
    if (!has(disabled, ZERO_COPY_CAPTURE)) disabled.push(ZERO_COPY_CAPTURE);
  } else if (
    options.chromiumVersion?.split('.')[0] === '152' &&
    !has(disabled, ZERO_COPY_CAPTURE) && !has(enabled, ZERO_COPY_CAPTURE)
  ) {
    enabled.push(ZERO_COPY_CAPTURE);
  }

  return { enabledFeatures: enabled.join(','), disabledFeatures: disabled.join(',') };
}
