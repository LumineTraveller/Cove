import test from 'node:test';
import assert from 'node:assert/strict';
import { screenCaptureFeaturePolicy } from '../electron/screen-capture-features';

test('the measured Windows engine merges capture defaults with external features', () => {
  assert.deepEqual(screenCaptureFeaturePolicy({
    platform: 'win32', chromiumVersion: '152.0.7977.54',
    enabledFeatures: 'ExistingFeature<Study:mode/fast,OtherFeature', disabledFeatures: 'DisabledFeature',
  }), {
    enabledFeatures: 'ExistingFeature<Study:mode/fast,OtherFeature,AllowWgcScreenCapturer,ZeroCopyDesktopCapture',
    disabledFeatures: 'DisabledFeature',
  });
});

test('explicit external feature disable wins over the new default', () => {
  assert.deepEqual(screenCaptureFeaturePolicy({
    platform: 'win32', chromiumVersion: '152.0.7977.54',
    disabledFeatures: 'ZeroCopyDesktopCapture,OtherDisabled',
  }), { enabledFeatures: 'AllowWgcScreenCapturer', disabledFeatures: 'ZeroCopyDesktopCapture,OtherDisabled' });
});

test('process rollback removes even parameterized enablement and preserves other choices', () => {
  assert.deepEqual(screenCaptureFeaturePolicy({
    platform: 'win32', chromiumVersion: '152.0.7977.54', disableZeroCopy: true,
    enabledFeatures: 'Existing,ZeroCopyDesktopCapture<Study:mode/fast', disabledFeatures: 'OtherDisabled',
  }), { enabledFeatures: 'Existing,AllowWgcScreenCapturer', disabledFeatures: 'OtherDisabled,ZeroCopyDesktopCapture' });
});

test('other engines retain the earlier default pending validation', () => {
  for (const chromiumVersion of [undefined, '', '151.0.0.0', '153.0.0.0']) {
    assert.deepEqual(screenCaptureFeaturePolicy({ platform: 'win32', chromiumVersion }), {
      enabledFeatures: 'AllowWgcScreenCapturer', disabledFeatures: '',
    });
  }
});

test('non-Windows startup does not alter feature choices', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(screenCaptureFeaturePolicy({
      platform, chromiumVersion: '152.0.7977.54', enabledFeatures: 'Existing',
      disabledFeatures: 'OtherDisabled', disableZeroCopy: true,
    }), { enabledFeatures: 'Existing', disabledFeatures: 'OtherDisabled' });
  }
});

test('an explicit parameterized feature and existing WGC entry are not duplicated', () => {
  assert.equal(screenCaptureFeaturePolicy({
    platform: 'win32', chromiumVersion: '152.0.7977.54',
    enabledFeatures: 'AllowWgcScreenCapturer,ZeroCopyDesktopCapture<Study:mode/fast',
  }).enabledFeatures, 'AllowWgcScreenCapturer,ZeroCopyDesktopCapture<Study:mode/fast');
});
