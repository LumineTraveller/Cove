import InCallManager from 'react-native-incall-manager';

export function startVoiceAudioSession() {
  // Audio focus is still managed by InCallManager, but not routing/proximity.
  InCallManager.start({ media: 'audio', auto: false });
  InCallManager.stopProximitySensor();
  InCallManager.turnScreenOn();
  InCallManager.setKeepScreenOn(false);
  InCallManager.setForceSpeakerphoneOn(true);
  InCallManager.setSpeakerphoneOn(true);
}
