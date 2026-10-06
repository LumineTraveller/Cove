import { BLUETOOTH_OUTPUT_ID, DEFAULT_INPUT_ID, DEFAULT_OUTPUT_ID, EARPIECE_OUTPUT_ID, inputDeviceLabel, isAudioDeviceBridgeAvailable, listAudioDevices, outputDeviceLabel, setAudioInputDevice, setAudioOutputDevice } from '../src/features/media/audio/audioDevices';

const mockList = jest.fn(async () => ({
  inputs: [{ id: 'default', label: '系统默认麦克风', isDefault: true }, { id: 'in-1', label: '内置麦克风' }],
  outputs: [{ id: 'out-speaker', label: '扬声器' }, { id: 'out-earpiece', label: '听筒' }],
  inputId: 'default',
  outputId: 'out-speaker',
}));
const mockSetIn = jest.fn(async (id: string) => id);
const mockSetOut = jest.fn(async (id: string) => id);

jest.mock('react-native', () => ({
  NativeModules: {
    CoveNative: {
      listAudioDevices: () => mockList(),
      setAudioInputDevice: (id: string) => mockSetIn(id),
      setAudioOutputDevice: (id: string) => mockSetOut(id),
    },
  },
}));

describe('audioDevices bridge', () => {
  beforeEach(() => {
    mockList.mockClear();
    mockSetIn.mockClear();
    mockSetOut.mockClear();
  });

  test('exposes stable default ids and labels', () => {
    expect(DEFAULT_INPUT_ID).toBe('default');
    expect(DEFAULT_OUTPUT_ID).toBe('out-speaker');
    expect(EARPIECE_OUTPUT_ID).toBe('out-earpiece');
    expect(BLUETOOTH_OUTPUT_ID).toBe('out-bluetooth');
    expect(outputDeviceLabel('out-speaker', [{ id: 'out-speaker', label: '扬声器' }])).toBe('扬声器');
    expect(inputDeviceLabel('missing', [])).toBe('系统默认麦克风');
    expect(isAudioDeviceBridgeAvailable()).toBe(true);
  });

  test('lists inputs and outputs and tracks selection', async () => {
    const list = await listAudioDevices();
    expect(list.inputs.map((device) => device.id)).toEqual(['default', 'in-1']);
    expect(list.outputs.map((device) => device.id)).toEqual(['out-speaker', 'out-earpiece']);
    expect(list.outputId).toBe('out-speaker');
  });

  test('setters push ids to native', async () => {
    await expect(setAudioInputDevice('in-1')).resolves.toBe('in-1');
    await expect(setAudioOutputDevice('out-earpiece')).resolves.toBe('out-earpiece');
    expect(mockSetIn).toHaveBeenCalledWith('in-1');
    expect(mockSetOut).toHaveBeenCalledWith('out-earpiece');
  });
});
