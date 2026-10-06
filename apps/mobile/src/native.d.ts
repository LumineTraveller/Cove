declare module 'react-native-incall-manager' {
  interface StartOptions {
    media?: 'audio' | 'video';
    auto?: boolean;
    ringback?: string;
  }

  const InCallManager: {
    start(options?: StartOptions): void;
    stop(options?: { busytone?: string }): void;
    setForceSpeakerphoneOn(enabled: boolean | null): void;
    stopProximitySensor(): void;
    turnScreenOn(): void;
    setKeepScreenOn(enabled: boolean): void;
    setSpeakerphoneOn(enabled: boolean): void;
  };

  export default InCallManager;
}
