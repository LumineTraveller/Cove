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
  mode: 'system',
  effectiveMode: 'system',
  rnnoiseReady: false,
  interceptorActive: false,
  processing: false,
  systemNoiseSuppressorEnabled: true,
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
  test('defaults to system noise suppression while allowing RNNoise', () => {
    expect(DEFAULT_NOISE_MODE).toBe('system');
    expect(isMicrophoneNoiseMode(DEFAULT_NOISE_MODE)).toBe(true);
    expect(noiseModeLabel('rnnoise')).toBe('RNNoise');
    expect(noiseModeLabel('system')).toBe('系统降噪');
    expect(NOISE_MODES.map((option) => option.value)).toEqual(['system', 'rnnoise']);
    expect(NOISE_MODES.find((option) => option.value === 'rnnoise')?.disabled).not.toBe(true);
  });

  test('Android uses native WebRTC NS keys and never stacks NS with RNNoise', () => {
    expect(createMicrophoneConstraints('system')).toMatchObject({ googEchoCancellation: true, googNoiseSuppression: true, googAutoGainControl: false });
    expect(createMicrophoneConstraints('rnnoise')).toMatchObject({ googEchoCancellation: true, googNoiseSuppression: false, googNoiseSuppression2: false, googAutoGainControl: false });
    expect(createMicrophoneConstraints('rnnoise')).not.toHaveProperty('noiseSuppression');
  });

  test('RNNoise is supported by the Android native bridge', () => {
    expect(isRnnoiseSupported()).toBe(true);
  });
});

describe('microphoneNoise native bridge', () => {
  beforeEach(() => {
    mockSet.mockClear();
    mockGet.mockClear();
  });

  test('applyNoiseMode pushes the mode and reads back status', async () => {
    mockGet.mockResolvedValueOnce({ mode: 'rnnoise', effectiveMode: 'rnnoise', rnnoiseReady: true, interceptorActive: true, processing: true, systemNoiseSuppressorEnabled: false });
    const status = await applyNoiseMode('rnnoise');
    expect(mockSet).toHaveBeenCalledWith('rnnoise');
    expect(mockGet).toHaveBeenCalled();
    expect(status.mode).toBe('rnnoise');
    expect(status.effectiveMode).toBe('rnnoise');
    expect(status.processing).toBe(true);
    expect(status.systemNoiseSuppressorEnabled).toBe(false);
  });

  test('getNoiseStatus normalizes missing fields to a safe fallback', async () => {
    mockGet.mockResolvedValueOnce({ mode: 'nope', effectiveMode: 'weird' } as never);
    const status = await getNoiseStatus();
    expect(status.mode).toBe('system');
    expect(status.effectiveMode).toBe('system');
    expect(status.rnnoiseReady).toBe(false);
    expect(status.processing).toBe(false);
  });

  test('invalid modes are rejected by isMicrophoneNoiseMode', () => {
    expect(isMicrophoneNoiseMode('off')).toBe(false);
    expect(isMicrophoneNoiseMode(null)).toBe(false);
  });

  test('native initialization errors are not disguised as a successful mode change', async () => {
    mockSet.mockRejectedValueOnce(new Error('RNNoise 模型不可用'));
    await expect(applyNoiseMode('rnnoise')).rejects.toThrow('RNNoise 模型不可用');
  });

  test('processing faults remain available for automatic system fallback', async () => {
    mockGet.mockResolvedValueOnce({ mode: 'rnnoise', effectiveMode: 'rnnoise', error: '48 kHz required' } as never);
    expect((await getNoiseStatus()).error).toBe('48 kHz required');
  });
});
