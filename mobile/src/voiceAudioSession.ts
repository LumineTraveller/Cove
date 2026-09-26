import InCallManager from 'react-native-incall-manager';

export function startVoiceAudioSession() {
  // Audio focus is still managed by InCallManager, but routing is owned by
  // AudioRouteRuntime so the user's input/output choice is preserved.
  InCallManager.start({ media: 'audio', auto: false });
  InCallManager.stopProximitySensor();
  InCallManager.turnScreenOn();
  InCallManager.setKeepScreenOn(false);
  InCallManager.setForceSpeakerphoneOn(null);
  InCallManager.setSpeakerphoneOn(false);
}
