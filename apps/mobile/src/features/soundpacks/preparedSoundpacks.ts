import { NativeModules, Platform } from 'react-native';
import type { SoundpackFileSource } from './soundpackAccess';

export interface PreparedSoundpackSource extends SoundpackFileSource {
  soundId: string;
  version: string;
  serverURL: string;
  roomId: string;
}
export interface PreparedSoundpacksNative {
  configure(session: string): void;
  clear(session: string): void;
  prepare(session: string, source: PreparedSoundpackSource): Promise<boolean>;
  play(
    session: string,
    soundId: string,
    version: string,
    key: number,
    volume: number,
  ): Promise<boolean>;
  stop(session: string): void;
  setVolume(session: string, volume: number): void;
  addListener(name: string): void;
  removeListeners(count: number): void;
}
export const preparedSoundpacks: PreparedSoundpacksNative | undefined =
  Platform.OS === 'android' ? NativeModules.CoveSoundpackPlayback : undefined;
