import InCallManager from 'react-native-incall-manager';
import { startVoiceAudioSession } from '../src/features/media/audio/voiceAudioSession';

jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(), stopProximitySensor: jest.fn(), turnScreenOn: jest.fn(),
  setKeepScreenOn: jest.fn(), setForceSpeakerphoneOn: jest.fn(), setSpeakerphoneOn: jest.fn(),
}));

test('voice session disables proximity and does not force a route', () => {
  startVoiceAudioSession();
  expect(InCallManager.start).toHaveBeenCalledWith({ media: 'audio', auto: false });
  expect(InCallManager.stopProximitySensor).toHaveBeenCalled();
  expect(InCallManager.turnScreenOn).toHaveBeenCalled();
  expect(InCallManager.setKeepScreenOn).toHaveBeenCalledWith(false);
  // 路由由 AudioRouteRuntime 按用户选择处理，InCallManager 不能抢走扬声器。
  expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(null);
  expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(false);
});
