import InCallManager from 'react-native-incall-manager';
import { startVoiceAudioSession } from '../src/voiceAudioSession';

jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(), stopProximitySensor: jest.fn(), turnScreenOn: jest.fn(),
  setKeepScreenOn: jest.fn(), setForceSpeakerphoneOn: jest.fn(), setSpeakerphoneOn: jest.fn(),
}));

test('voice retains speaker routing but disables proximity and allows normal sleep', () => {
  startVoiceAudioSession();
  expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio', auto: false });
  expect(InCallManager.stopProximitySensor).toHaveBeenCalled();
  expect(InCallManager.turnScreenOn).toHaveBeenCalled();
  expect(InCallManager.setKeepScreenOn).toHaveBeenCalledWith(false);
  expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(true);
  expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(true);
});
