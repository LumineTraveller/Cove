import {
  SCREEN_FPS_OPTIONS,
  SCREEN_PRESETS,
  type ScreenFps,
  type ScreenPreset,
} from './screenCapture';

export const SCREEN_PREFERENCES_KEY = 'cove_screen_preferences_v1';

export interface ScreenPreferences {
  preset: ScreenPreset;
  fps: ScreenFps;
  audio: boolean;
  gameMode: boolean;
  nativeResolution: boolean;
  compatibilityMode: boolean;
}

export const DEFAULT_SCREEN_PREFERENCES: Readonly<ScreenPreferences> = {
  preset: '720p',
  fps: 30,
  audio: false,
  gameMode: false,
  nativeResolution: false,
  compatibilityMode: false,
};

/** Older partial settings retain supported values; missing/invalid fields use safe defaults. */
export function normalizeScreenPreferences(value: unknown): ScreenPreferences {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    preset:
      typeof saved.preset === 'string' && Object.prototype.hasOwnProperty.call(SCREEN_PRESETS, saved.preset)
        ? (saved.preset as ScreenPreset)
        : DEFAULT_SCREEN_PREFERENCES.preset,
    fps: SCREEN_FPS_OPTIONS.some((fps) => fps === saved.fps)
      ? (saved.fps as ScreenFps)
      : DEFAULT_SCREEN_PREFERENCES.fps,
    audio: typeof saved.audio === 'boolean' ? saved.audio : DEFAULT_SCREEN_PREFERENCES.audio,
    gameMode:
      typeof saved.gameMode === 'boolean' ? saved.gameMode : DEFAULT_SCREEN_PREFERENCES.gameMode,
    nativeResolution:
      typeof saved.nativeResolution === 'boolean'
        ? saved.nativeResolution
        : DEFAULT_SCREEN_PREFERENCES.nativeResolution,
    compatibilityMode: typeof saved.compatibilityMode === 'boolean'
      ? saved.compatibilityMode : DEFAULT_SCREEN_PREFERENCES.compatibilityMode,
  };
}

export function loadScreenPreferences(storage?: Pick<Storage, 'getItem'>): ScreenPreferences {
  try {
    const saved = (storage ?? localStorage).getItem(SCREEN_PREFERENCES_KEY);
    return normalizeScreenPreferences(JSON.parse(saved ?? 'null'));
  } catch {
    return { ...DEFAULT_SCREEN_PREFERENCES };
  }
}

export function saveScreenPreferences(
  preferences: ScreenPreferences,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? localStorage).setItem(
      SCREEN_PREFERENCES_KEY,
      JSON.stringify(normalizeScreenPreferences(preferences)),
    );
  } catch {
    // Storage restrictions must not prevent local capture or sharing.
  }
}
