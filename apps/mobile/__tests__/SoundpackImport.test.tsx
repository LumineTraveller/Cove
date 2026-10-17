import TestRenderer, {act} from 'react-test-renderer';
import {TextInput} from 'react-native';
import {CoveButton} from '../src/components/CoveUi';
import {SoundpackImport, soundpackSelection} from '../src/features/soundpacks/components/SoundpackImport';
import {cancelOperations, pickAudioFiles, readAudioSelection, releaseAudioFiles} from '../src/features/soundpacks/soundpackFiles';
import {serverFetch} from '../src/features/connection/serverSecurity';
import type {SoundboardController} from '../src/features/soundpacks/useSoundboard';

jest.mock('lucide-react-native', () => {const React = require('react'); return new Proxy({}, {get: (_target, name: string) => () => React.createElement('Icon', {name})});});
jest.mock('react-native-video', () => ({__esModule: true, default: 'Video'}));
jest.mock('../src/features/soundpacks/soundpackFiles', () => ({pickAudioFiles: jest.fn(), readAudioSelection: jest.fn(), releaseAudioFiles: jest.fn(async () => undefined), cancelOperations: jest.fn(async () => undefined)}));
jest.mock('../src/features/connection/serverSecurity', () => ({serverFetch: jest.fn()}));
const audio = (id: string) => ({id, name: `${id}.mp3`, mimeType: 'audio/mpeg', size: 1024, duration: 10, uri: `file:///synthetic/${id}.mp3`});
const deferred = <T,>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};};

describe('SAF audio selection, trim, upload and cancellation', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let board: SoundboardController;
  const button = (title: string) => renderer.root.findAllByType(CoveButton).find(node => node.props.title === title)!;
  const press = async (title: string) => {await act(async () => button(title).props.onPress());};
  const input = (label: string) => renderer.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === label)!;
  const mount = async () => {if (renderer) return; await act(async () => {renderer = TestRenderer.create(<SoundpackImport controller={board}/>);});};
  // Cold native/Pressable initialization is fixture setup, not a behavior timeout.
  beforeEach(async () => {
    renderer = undefined as any;
    jest.clearAllMocks();
    board = {ready: true, scope: 'server:alice:room', serverURL: 'http://fixture.test/cove', roomId: 'room', socket: {id: 'synthetic-self'}, volume: 0.6, requestInit: jest.fn((init: RequestInit) => ({...init, headers: {...init.headers, 'X-Cove-Account-Token': 'synthetic-account-token'}})), setNotice: jest.fn()} as unknown as SoundboardController;
    (pickAudioFiles as jest.Mock).mockResolvedValue([audio('one'), audio('two')]);
    (readAudioSelection as jest.Mock).mockResolvedValue({data: 'U1lOVEhFVElD', mimeType: 'audio/wav', size: 2048, duration: 3, uri: 'file:///synthetic/clip.wav'});
    (serverFetch as jest.Mock).mockResolvedValue({ok: true, json: async () => ({id: 'uploaded'})});
    await mount();
  }, 30_000);
  afterEach(async () => {if (renderer) await act(async () => renderer.unmount());});
  test.each([
    ['0', '10', 10, {start: 0, end: 10}], ['1.2', '3.4', 10, {start: 1.2, end: 3.4}],
    ['-1', '2', 10, null], ['2', '2', 10, null], ['1', '11', 10, null], ['', '2', 10, null], ['0x1', '2', 10, null],
  ])('validates start %s and end %s before native decoding', (start, end, duration, result) => {
    expect(soundpackSelection(start as string, end as string, duration as number)).toEqual(result);
  });
  test('batch confirmation preserves existing HTTP contract and advances to next selected audio', async () => {
    await mount(); await press('上传音频');
    await act(async () => {input('上传语音包名称').props.onChangeText('自定义声音'); input('音频开始时间（秒）').props.onChangeText('2'); input('音频结束时间（秒）').props.onChangeText('5');});
    await press('确认并上传'); expect(readAudioSelection).toHaveBeenCalledWith('one', 2, 5);
    expect(serverFetch).toHaveBeenCalledWith('http://fixture.test/cove', '/api/soundpacks', expect.objectContaining({method: 'POST', body: JSON.stringify({name: '自定义声音', data: 'U1lOVEhFVElD', mimeType: 'audio/wav', roomId: 'room'})}));
    expect(input('上传语音包名称').props.value).toBe('two'); await press('跳过此音频');
    expect(board.setNotice).toHaveBeenCalledWith('音频上传完成：成功 1 个，跳过 1 个。');
    expect(releaseAudioFiles).toHaveBeenCalledWith(['one', 'two']);
  });
  test('picker cancellation leaves upload count and network untouched', async () => {
    (pickAudioFiles as jest.Mock).mockResolvedValue([]); await mount(); await press('上传音频'); expect(serverFetch).not.toHaveBeenCalled(); expect(button('上传音频')).toBeDefined();
  });
  test('same-render duplicate upload is ignored immediately', async () => {
    const pending = deferred<any>(); (readAudioSelection as jest.Mock).mockReturnValue(pending.promise);
    await mount(); await press('上传音频'); const submit = button('确认并上传');
    await act(async () => {submit.props.onPress(); submit.props.onPress();}); expect(readAudioSelection).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({data: 'AAAA', mimeType: 'audio/mpeg', size: 3, duration: 10, uri: 'file:///synthetic/one.mp3'}));
    expect(serverFetch).toHaveBeenCalledTimes(1);
  });
  test('cancel while native decoding is pending prevents later HTTP upload', async () => {
    const pending = deferred<any>(); (readAudioSelection as jest.Mock).mockReturnValue(pending.promise);
    await mount(); await press('上传音频'); await press('确认并上传'); await press('取消上传');
    await act(async () => pending.resolve({data: 'AAAA', mimeType: 'audio/mpeg', size: 3, duration: 10, uri: 'file:///synthetic/one.mp3'}));
    expect(serverFetch).not.toHaveBeenCalled(); expect(cancelOperations).toHaveBeenCalled(); expect(button('上传音频')).toBeDefined();
  });
  test('account switch releases pending picker files and cannot attach them to the next account', async () => {
    const pending = deferred<any>(); (pickAudioFiles as jest.Mock).mockReturnValue(pending.promise);
    await mount(); await press('上传音频'); board = {...board, scope: 'server:bob:room'};
    await act(async () => renderer.update(<SoundpackImport controller={board}/>)); await act(async () => pending.resolve([audio('old')]));
    expect(releaseAudioFiles).toHaveBeenCalledWith(['old']); expect(serverFetch).not.toHaveBeenCalled(); expect(button('上传音频')).toBeDefined();
  });
  test('HTTP error keeps selected audio for retry and allows cancel', async () => {
    (serverFetch as jest.Mock).mockResolvedValue({ok: false, json: async () => ({error: '合成服务器拒绝'})});
    await mount(); await press('上传音频'); await press('确认并上传'); expect(JSON.stringify(renderer.toJSON())).toContain('合成服务器拒绝');
    expect(input('上传语音包名称').props.value).toBe('one'); await press('取消上传'); expect(button('上传音频')).toBeDefined();
  });
  test('oversized native clip cannot be posted', async () => {
    (readAudioSelection as jest.Mock).mockResolvedValue({data: 'AAAA', mimeType: 'audio/wav', size: 8 * 1024 * 1024 + 1, duration: 10, uri: 'file:///synthetic/clip.wav'});
    await mount(); await press('上传音频'); await press('确认并上传'); expect(serverFetch).not.toHaveBeenCalled(); expect(JSON.stringify(renderer.toJSON())).toContain('超过 8MB');
  });
  test('preview receives device soundpack volume and stops at selected end', async () => {
    await mount(); await press('上传音频'); await press('试听片段'); const player = renderer.root.findByType('Video' as any);
    expect(player.props.volume).toBe(0.6); expect(player.props.source.uri).toBe(audio('one').uri);
    await act(async () => player.props.onProgress({currentTime: 10})); expect(renderer.root.findAllByType('Video' as any)).toHaveLength(0);
  });
});

test('changing room aborts an in-flight HTTP upload and ignores its late success', async () => {
  const waiting = deferred<any>();
  (serverFetch as jest.Mock).mockReturnValue(waiting.promise);
  const setNotice = jest.fn();
  let board = {ready: true, scope: 'server:alice:room-a', serverURL: 'http://fixture.test/cove', roomId: 'room-a', volume: 1,
    requestInit: (init: RequestInit) => ({...init, headers: {'X-Cove-Account-Token': 'synthetic-account-token'}}), setNotice} as unknown as SoundboardController;
  (pickAudioFiles as jest.Mock).mockResolvedValue([audio('one')]);
  (readAudioSelection as jest.Mock).mockResolvedValue({data: 'AAAA', mimeType: 'audio/mpeg', size: 3, duration: 10, uri: 'file:///synthetic/one.mp3'});
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {renderer = TestRenderer.create(<SoundpackImport controller={board}/>);});
  const button = (title: string) => renderer.root.findAllByType(CoveButton).find(node => node.props.title === title)!;
  await act(async () => button('上传音频').props.onPress());
  await act(async () => button('确认并上传').props.onPress());
  const init = (serverFetch as jest.Mock).mock.calls.at(-1)![2];
  expect(init.headers['X-Cove-Account-Token']).toBe('synthetic-account-token');
  expect(JSON.parse(init.body).roomId).toBe('room-a');
  board = {...board, scope: 'server:alice:room-b', roomId: 'room-b'};
  await act(async () => renderer.update(<SoundpackImport controller={board}/>));
  expect(init.signal.aborted).toBe(true);
  await act(async () => waiting.resolve({ok: true}));
  expect(setNotice).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
