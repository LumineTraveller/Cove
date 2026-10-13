import TestRenderer, {act} from 'react-test-renderer';
import {SoundpackPlayer} from '../src/features/soundpacks/components/SoundpackPlayer';
import {setAudioOutputDevice} from '../src/features/media/audio/audioDevices';
import type {SoundboardController} from '../src/features/soundpacks/useSoundboard';
jest.mock('react-native-video', () => ({__esModule: true, default: 'Video'}));
jest.mock('../src/features/media/audio/audioDevices', () => ({setAudioOutputDevice: jest.fn(async id => id)}));
const deferred = <T,>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};};
describe('soundpack output route ownership', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let board: SoundboardController;
  const player = () => renderer.root.findByType('Video' as any);
  beforeEach(async () => {
    jest.clearAllMocks(); (setAudioOutputDevice as jest.Mock).mockImplementation(async id => id);
    board = {ready: true, inVoice: true, scope: 'fixture', outputDeviceId: 'out-bluetooth', volume: 0.5,
      playback: {key: 1, soundId: 'a', uri: 'http://fixture.test/a.mp3'}, playbackEnded: jest.fn(), setNotice: jest.fn()} as unknown as SoundboardController;
    await act(async () => {renderer = TestRenderer.create(<SoundpackPlayer controller={board}/>);});
  }, 30_000);
  afterEach(async () => {await act(async () => renderer.unmount());});
  test('initial playback stays paused until native confirms the existing selected output', async () => {
    const pending = deferred<string>(); (setAudioOutputDevice as jest.Mock).mockReturnValue(pending.promise);
    expect(player().props.paused).toBe(true); expect(player().props.disableFocus).toBe(true); expect(player().props.audioOutput).toBe('earpiece');
    await act(async () => {player().props.onLoad();}); expect(player().props.paused).toBe(true);
    expect(setAudioOutputDevice).toHaveBeenCalledWith('out-bluetooth'); await act(async () => pending.resolve('out-bluetooth')); expect(player().props.paused).toBe(false);
  });
  test('output changes pause the new player and a stale onLoad cannot unpause it', async () => {
    const pending = deferred<string>(); (setAudioOutputDevice as jest.Mock).mockReturnValueOnce(pending.promise);
    await act(async () => {player().props.onLoad();}); board = {...board, outputDeviceId: 'out-earpiece'};
    await act(async () => renderer.update(<SoundpackPlayer controller={board}/>)); expect(player().props.paused).toBe(true);
    await act(async () => pending.resolve('out-bluetooth')); expect(player().props.paused).toBe(true);
    await act(async () => player().props.onLoad()); expect(player().props.paused).toBe(false); expect(setAudioOutputDevice).toHaveBeenLastCalledWith('out-earpiece');
  });
  test('route rejection keeps audio paused and reports the unavailable output', async () => {
    (setAudioOutputDevice as jest.Mock).mockRejectedValue(new Error('合成蓝牙已断开'));
    await act(async () => player().props.onLoad()); expect(player().props.paused).toBe(true);
    expect(board.playbackEnded).toHaveBeenCalledWith(1, true); expect(board.setNotice).toHaveBeenCalledWith('语音包输出失败：合成蓝牙已断开');
  });
  test('unsupported fallback cannot silently play a Bluetooth request over speaker', async () => {
    (setAudioOutputDevice as jest.Mock).mockResolvedValue('out-speaker');
    await act(async () => player().props.onLoad()); expect(player().props.paused).toBe(true); expect(board.setNotice).toHaveBeenCalledWith(expect.stringContaining('当前不可用'));
  });
});
