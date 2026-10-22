import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCREEN_PREFERENCES,
  SCREEN_PREFERENCES_KEY,
  loadScreenPreferences,
  normalizeScreenPreferences,
  saveScreenPreferences,
} from '../src/features/media/screen/screenPreferences';

test('missing/corrupt settings preserve the original safe defaults', () => {
  assert.deepEqual(loadScreenPreferences({ getItem: () => null }), DEFAULT_SCREEN_PREFERENCES);
  assert.deepEqual(loadScreenPreferences({ getItem: () => '{bad json' }), DEFAULT_SCREEN_PREFERENCES);
  assert.deepEqual(loadScreenPreferences({ getItem: () => { throw new Error('restricted'); } }), DEFAULT_SCREEN_PREFERENCES);
  assert.deepEqual(normalizeScreenPreferences({ preset: '4K', fps: 240, gameMode: 'false' }), DEFAULT_SCREEN_PREFERENCES);
});

test('older 30/60 FPS or partial settings remain usable without resetting valid resolution preferences', () => {
  for (const fps of [30, 60]) {
    assert.deepEqual(normalizeScreenPreferences({ preset: '1440p', fps }), {
      ...DEFAULT_SCREEN_PREFERENCES, preset: '1440p', fps,
    });
  }
  assert.equal(normalizeScreenPreferences({ preset: '1080p', fps: 45 }).preset, '1080p');
});

test('120 FPS and every resolution/mode preference survive a storage round trip', () => {
  let saved: string | null = null;
  const storage = {
    getItem: (key: string) => { assert.equal(key, SCREEN_PREFERENCES_KEY); return saved; },
    setItem: (key: string, value: string) => { assert.equal(key, SCREEN_PREFERENCES_KEY); saved = value; },
  };
  const preferences = { preset: '1080p' as const, fps: 120 as const, audio: true, gameMode: true, nativeResolution: true, compatibilityMode: true };
  saveScreenPreferences(preferences, storage);
  assert.deepEqual(loadScreenPreferences(storage), preferences);
  assert.doesNotThrow(() => saveScreenPreferences(preferences, { setItem: () => { throw new Error('full'); } }));
});

test('compatibility is explicitly enabled and old or invalid stored values never silently enable it', () => {
  assert.equal(normalizeScreenPreferences({ compatibilityMode: true }).compatibilityMode, true);
  for (const compatibilityMode of [undefined, null, 'true', 1, false]) {
    assert.equal(normalizeScreenPreferences({ compatibilityMode }).compatibilityMode, false);
  }
});
