import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScreenCaptureEnabled, supportsPackedScreenCapture } from '../electron/native-screen-capture-policy';

const release = {
  platform: 'win32', arch: 'x64', electronVersion: '44.0.0', isPackaged: true,
  buildFlavor: undefined, optIn: undefined, disable: undefined,
};
const versions = [undefined, '', '43.9.9', '44.0.0', '44.0.1', '44.4.1', '45.0.0'];
const flavors = [undefined, '', 'native-capture-lab', 'network-lab', 'annotation-fix', 'media-fix', 'unknown'];
const environmentValues = [undefined, '', '0', '1', 'true'];

test('packed capture selects the qualified GPU and CPU profile only', () => {
  const device = { vendorId: 0x10de, deviceId: 0x28e0, driverVersion: '32.0.15.6094' };
  const cpu = 'AMD Ryzen 9 7945HX with Radeon Graphics';
  assert.equal(supportsPackedScreenCapture({ gpuDevice: [device, device, { vendorId: 0x1414 }] }, cpu), true);
  assert.equal(supportsPackedScreenCapture({ gpuDevice: [device] }, 'AMD Ryzen 5 5600'), false);
  assert.equal(supportsPackedScreenCapture({ gpuDevice: [{ ...device, driverVersion: '32.0.15.0000' }] }, cpu), false);
  assert.equal(supportsPackedScreenCapture({ gpuDevice: [device, { vendorId: 0x1002 }] }, cpu), false);
  assert.equal(supportsPackedScreenCapture({ gpuDevice: [] }, cpu), false);
});

test('only the exact qualified Windows x64 release runtime gains a default', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64', 'ia32']) {
      for (const electronVersion of versions) {
        assert.equal(nativeScreenCaptureEnabled({ ...release, platform, arch, electronVersion }),
          platform === 'win32' && arch === 'x64' && electronVersion === '44.0.0',
          `${platform}/${arch}/${electronVersion}`);
      }
    }
  }
});

test('unpackaged development and other packaged flavors keep their prior defaults', () => {
  for (const isPackaged of [false, true]) {
    for (const buildFlavor of flavors) {
      for (const electronVersion of versions) {
        const expected = buildFlavor === 'native-capture-lab' ||
          (isPackaged && buildFlavor === undefined && electronVersion === '44.0.0');
        assert.equal(nativeScreenCaptureEnabled({ ...release, isPackaged, buildFlavor, electronVersion }), expected,
          `${isPackaged}/${buildFlavor}/${electronVersion}`);
      }
    }
  }
});

test('explicit opt-in keeps the old platform and architecture boundary for every runtime and flavor', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64', 'ia32']) {
      for (const isPackaged of [false, true]) {
        for (const buildFlavor of flavors) {
          for (const electronVersion of versions) {
            assert.equal(nativeScreenCaptureEnabled({
              ...release, platform, arch, isPackaged, buildFlavor, electronVersion, optIn: '1',
            }), platform === 'win32' && arch === 'x64',
            `${platform}/${arch}/${isPackaged}/${buildFlavor}/${electronVersion}`);
          }
        }
      }
    }
  }
});

test('the disable switch wins over release, native lab and explicit opt-in together', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64', 'ia32']) {
      for (const isPackaged of [false, true]) {
        for (const buildFlavor of flavors) {
          for (const electronVersion of versions) {
            for (const optIn of environmentValues) {
              assert.equal(nativeScreenCaptureEnabled({
                ...release, platform, arch, isPackaged, buildFlavor, electronVersion, optIn, disable: '1',
              }), false);
            }
          }
        }
      }
    }
  }
});

test('environment switches retain exact string semantics in development and formal releases', () => {
  for (const optIn of environmentValues) {
    for (const disable of environmentValues) {
      assert.equal(nativeScreenCaptureEnabled({ ...release, optIn, disable }), disable !== '1');
      assert.equal(nativeScreenCaptureEnabled({ ...release, isPackaged: false, optIn, disable }),
        optIn === '1' && disable !== '1');
      assert.equal(nativeScreenCaptureEnabled({ ...release, buildFlavor: 'network-lab', optIn, disable }),
        optIn === '1' && disable !== '1');
    }
  }
});
