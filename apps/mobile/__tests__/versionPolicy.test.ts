import {
  readUpgradePolicy,
  safeUpgradeURL,
} from '../src/features/updates/versionPolicy';
test('semantic minimum rejects old, malformed and prerelease versions', () => {
  for (const version of ['0.7.9', '0.8.0-rc.1', 'invalid', null])
    expect(
      readUpgradePolicy({ minimumClientVersion: '0.8.0' }, version)
        ?.upgradeRequired,
    ).toBe(true);
  for (const version of ['0.8.0', '0.10.0', '3.0.0'])
    expect(
      readUpgradePolicy({ minimumClientVersion: '0.8.0' }, version)
        ?.upgradeRequired,
    ).toBe(false);
  expect(readUpgradePolicy({ minimumClientVersion: 'garbage' })).toBeNull();
  expect(readUpgradePolicy({})).toBeNull();
});
test('upgrade entry requires HTTPS without embedded credentials', () => {
  expect(safeUpgradeURL('https://download.test/Cove-Mobile.apk')).toBeTruthy();
  expect(safeUpgradeURL('http://download.test/Cove-Mobile.apk')).toBeNull();
  expect(
    safeUpgradeURL('https://user:secret@download.test/Cove-Mobile.apk'),
  ).toBeNull();
});
