import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeScreenCaptureScale,
  type ScreenCaptureScale,
} from './screenCaptureSettings';

export const SCREEN_SHARE_AUDIO_KEY = 'cove_screen_share_audio';
export const SCREEN_SHARE_SCALE_KEY = 'cove_screen_share_scale';
// The choice is an app preference, like desktop capture settings. Serialize
// writes across component lifetimes so a slow old save cannot undo a new choice.
let writes: Promise<void> = Promise.resolve();
let choiceRevision = 0;
let scaleWrites: Promise<void> = Promise.resolve();
let scaleRevision = 0;

export function useScreenSharingPreferences() {
  const [includeScreenAudio, setValue] = useState(false);
  const touched = useRef(false);
  const [screenCaptureScale, setScale] = useState<ScreenCaptureScale>(1);
  const scaleTouched = useRef(false);
  useEffect(() => {
    let current = true;
    const revision = choiceRevision;
    const restore = async () => {
      await writes;
      const value = await AsyncStorage.getItem(SCREEN_SHARE_AUDIO_KEY);
      if (current && !touched.current && revision === choiceRevision)
        setValue(value === 'true');
    };
    restore().catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    const revision = scaleRevision;
    const restore = async () => {
      await scaleWrites;
      const value = await AsyncStorage.getItem(SCREEN_SHARE_SCALE_KEY);
      if (current && !scaleTouched.current && revision === scaleRevision)
        setScale(normalizeScreenCaptureScale(value));
    };
    restore().catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  const setIncludeScreenAudio = useCallback((value: boolean) => {
    touched.current = true;
    ++choiceRevision;
    setValue(value);
    writes = writes
      .catch(() => {})
      .then(() => AsyncStorage.setItem(SCREEN_SHARE_AUDIO_KEY, String(value)))
      .catch(() => {});
  }, []);
  const setScreenCaptureScale = useCallback((value: ScreenCaptureScale) => {
    const scale = normalizeScreenCaptureScale(value);
    scaleTouched.current = true;
    ++scaleRevision;
    setScale(scale);
    scaleWrites = scaleWrites
      .catch(() => {})
      .then(() => AsyncStorage.setItem(SCREEN_SHARE_SCALE_KEY, String(scale)))
      .catch(() => {});
  }, []);
  return {
    includeScreenAudio,
    setIncludeScreenAudio,
    screenCaptureScale,
    setScreenCaptureScale,
  };
}
