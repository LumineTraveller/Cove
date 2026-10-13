import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

export const SCREEN_SHARE_AUDIO_KEY = 'cove_screen_share_audio';
// The choice is an app preference, like desktop capture settings. Serialize
// writes across component lifetimes so a slow old save cannot undo a new choice.
let writes: Promise<void> = Promise.resolve();
let choiceRevision = 0;

export function useScreenSharingPreferences() {
  const [includeScreenAudio, setValue] = useState(false);
  const touched = useRef(false);
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
  const setIncludeScreenAudio = useCallback((value: boolean) => {
    touched.current = true;
    ++choiceRevision;
    setValue(value);
    writes = writes
      .catch(() => {})
      .then(() => AsyncStorage.setItem(SCREEN_SHARE_AUDIO_KEY, String(value)))
      .catch(() => {});
  }, []);
  return { includeScreenAudio, setIncludeScreenAudio };
}
