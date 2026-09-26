import {
  applyNoiseMode,
  createMicrophoneConstraints,
  DEFAULT_NOISE_MODE,
  getNoiseStatus,
  isMicrophoneNoiseMode,
  isRnnoiseSupported,
  noiseModeLabel,
  NOISE_MODES,
} from '../src/microphoneNoise';

const mockSet = jest.fn(async (mode: string) => mode);
const mockGet = jest.fn(async () => ({
  mode: 'rnnoise',
  effectiveMode: 'rnnoise',
  rnnoiseReady: true,
  interceptorActive: true,
  processing: true,
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    CoveNative: {
      setMicrophoneNoiseMode: (mode: string) => mockSet(mode),
      getMicrophoneNoiseStatus: () => mockGet(),
    },
  },
}));

describe('microphoneNoise defaults and labels', () => {
  test('defaults to the improved RNNoise mode', () => {
    expect(DEFAULT_NOISE_MODE).toBe('rnnoise');
    expect(isMicrophoneNoiseMode(DEFAULT_NOISE_MODE)).toBe(true);
    expect(noiseModeLabel('rnnoise')).toBe('RNNoise（改进）');
    expect(noiseModeLabel('system')).toBe('系统降噪');
    expect(NOISE_MODES.map((option) => option.value)).toEqual(['rnnoise', 'system']);
  });

  test('RNNoise capture requests system NS off to avoid double suppression', () => {
    expect(createMicrophoneConstraints('rnnoise').noiseSuppression).toBe(false);
    expect(createMicrophoneConstraints('system').noiseSuppression).toBe(true);
    expect(createMicrophoneConstraints('rnnoise')).toMatchObject({
      echoCancellation: true,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48_000,
    });
  });

  test('android exposes the native RNNoise bridge', () => {
    expect(isRnnoiseSupported()).toBe(true);
  });
});

describe('microphoneNoise native bridge', () => {
  beforeEach(() => {
    mockSet.mockClear();
    mockGet.mockClear();
  });

  test('applyNoiseMode pushes the mode and reads back status', async () => {
    const status = await applyNoiseMode('system');
    expect(mockSet).toHaveBeenCalledWith('system');
    expect(mockGet).toHaveBeenCalled();
    expect(status.mode).toBe('rnnoise');
    expect(status.effectiveMode).toBe('rnnoise');
    expect(status.processing).toBe(true);
  });

  test('getNoiseStatus normalizes missing fields to a safe fallback', async () => {
    mockGet.mockResolvedValueOnce({ mode: 'nope', effectiveMode: 'weird' } as never);
    const status = await getNoiseStatus();
    expect(status.mode).toBe('rnnoise');
    expect(status.effectiveMode).toBe('system');
    expect(status.rnnoiseReady).toBe(false);
    expect(status.processing).toBe(false);
  });

  test('invalid modes are rejected by isMicrophoneNoiseMode', () => {
    expect(isMicrophoneNoiseMode('off')).toBe(false);
    expect(isMicrophoneNoiseMode(null)).toBe(false);
  });
});
