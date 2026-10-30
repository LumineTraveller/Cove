import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter } from 'react-native';
import {
  SoundpackPlayer,
  SOUNDPACK_BUFFER,
} from '../src/features/soundpacks/components/SoundpackPlayer';
import { preparedSoundpacks } from '../src/features/soundpacks/preparedSoundpacks';
import type { SoundboardController } from '../src/features/soundpacks/useSoundboard';
jest.mock('react-native-video', () => ({ __esModule: true, default: 'Video' }));
jest.mock('../src/features/media/audio/audioDevices', () => ({
  setAudioOutputDevice: jest.fn(async id => id),
}));
jest.mock('../src/features/soundpacks/preparedSoundpacks', () => ({
  preparedSoundpacks: {
    play: jest.fn(async () => true),
    stop: jest.fn(),
    setVolume: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

describe('prepared Android soundpack playback', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let board: SoundboardController;
  beforeEach(async () => {
    jest.clearAllMocks();
    (preparedSoundpacks!.play as jest.Mock).mockResolvedValue(true);
    board = {
      ready: true,
      inVoice: true,
      scope: 'room-a',
      playbackSession: 'session-a',
      outputDeviceId: 'out-bluetooth',
      volume: 0.6,
      playback: {
        key: 1,
        soundId: 'a',
        version: 'normalized-a.mp3',
        uri: 'http://test/audio',
      },
      playbackEnded: jest.fn(),
      setNotice: jest.fn(),
    } as unknown as SoundboardController;
    await act(async () => {
      renderer = TestRenderer.create(<SoundpackPlayer controller={board} />);
    });
  }, 30_000);
  afterEach(async () => {
    await act(async () => renderer.unmount());
  });
  test('a prepared clip starts directly without mounting or buffering a video player', () => {
    expect(preparedSoundpacks!.play).toHaveBeenCalledWith(
      'session-a',
      'a',
      'normalized-a.mp3',
      1,
      0.6,
    );
    expect(renderer.root.findAllByType('Video' as any)).toHaveLength(0);
  });
  test('volume changes do not restart playback and an empty playback stops native audio', async () => {
    board = { ...board, volume: 0.25 };
    await act(async () =>
      renderer.update(<SoundpackPlayer controller={board} />),
    );
    expect(preparedSoundpacks!.play).toHaveBeenCalledTimes(1);
    expect(preparedSoundpacks!.setVolume).toHaveBeenLastCalledWith(
      'session-a',
      0.25,
    );
    board = { ...board, playback: null };
    await act(async () =>
      renderer.update(<SoundpackPlayer controller={board} />),
    );
    expect(preparedSoundpacks!.stop).toHaveBeenLastCalledWith('session-a');
  });
  test('only completion from the current session and clip may clear playback', async () => {
    await act(async () => {
      DeviceEventEmitter.emit('CoveSoundpackEnded', {
        session: 'other-room',
        key: 1,
        error: false,
      });
      DeviceEventEmitter.emit('CoveSoundpackEnded', {
        session: 'session-a',
        key: 0,
        error: false,
      });
    });
    expect(board.playbackEnded).not.toHaveBeenCalled();
    await act(async () => {
      DeviceEventEmitter.emit('CoveSoundpackEnded', {
        session: 'session-a',
        key: 1,
        error: false,
      });
    });
    expect(board.playbackEnded).toHaveBeenCalledWith(1, false);
  });
  test('an uncached clip uses a small audio buffer while preserving existing route validation', async () => {
    (preparedSoundpacks!.play as jest.Mock).mockResolvedValueOnce(false);
    board = { ...board, playback: { ...board.playback!, key: 2 } };
    await act(async () =>
      renderer.update(<SoundpackPlayer controller={board} />),
    );
    const player = renderer.root.findByType('Video' as any);
    expect(player.props.source.bufferConfig).toEqual(SOUNDPACK_BUFFER);
    expect(player.props.paused).toBe(true);
    expect(player.props.disableFocus).toBe(true);
    await act(async () => player.props.onLoad());
    expect(renderer.root.findByType('Video' as any).props.paused).toBe(false);
  });
});
