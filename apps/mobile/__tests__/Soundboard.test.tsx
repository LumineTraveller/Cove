import TestRenderer, {act} from 'react-test-renderer';
import {Alert, TextInput, TouchableOpacity} from 'react-native';
import {CoveButton} from '../src/components/CoveUi';
import {Soundboard} from '../src/features/soundpacks/components/Soundboard';
import {saveSoundpack} from '../src/features/soundpacks/soundpackFiles';
import type {SoundboardController} from '../src/features/soundpacks/useSoundboard';
jest.mock('lucide-react-native', () => {const React = require('react'); return new Proxy({}, {get: (_target, name: string) => () => React.createElement('Icon', {name})});});
jest.mock('../src/features/soundpacks/components/SoundpackImport', () => ({SoundpackImport: 'SoundpackImport'}));
jest.mock('../src/features/soundpacks/soundpackFiles', () => ({saveSoundpack: jest.fn(async () => ({cancelled: false}))}));
jest.mock('../src/features/connection/serverSecurity', () => ({authorizedResourceURL: (base: string, path: string) => `${base}${path}?synthetic-key=fixture`}));

describe('soundboard touch management UI', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let board: SoundboardController;
  let visible: boolean;
  const render = async () => {await act(async () => {
    const view = <Soundboard controller={board} profileRemarks={{}} visible={visible}/>;
    if (renderer) renderer.update(view); else renderer = TestRenderer.create(view);
  });};
  const touch = (label: string) => renderer.root.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel === label)!;
  const button = (title: string) => renderer.root.findAllByType(CoveButton).find(node => node.props.title === title)!;
  const press = async (label: string) => {await act(async () => touch(label).props.onPress());};
  beforeEach(async () => {
    jest.clearAllMocks(); visible = true; renderer = undefined as any;
    board = {scope: 'server:alice:room', ready: true, inVoice: false, canManage: true, canAddGroup: true, serverURL: 'http://fixture.test/cove',
      groups: [{id: 'one', soundIds: ['a']}, {id: 'two', soundIds: ['b']}], favorites: [], volume: 0.5, playback: null,
      packs: [{id: 'a', name: '长中文合成测试声音名称', filename: 'a.normalized.mp3', originalFilename: 'a.original.wav', uploader: 'Synthetic', canDelete: true}, {id: 'b', name: '只读声音', filename: 'b.mp3', uploader: 'Synthetic', canDelete: false}],
      loading: false, loadError: null, notice: null, busy: null, moveSound: jest.fn(), swapGroups: jest.fn(), updateVolume: jest.fn(), triggerSound: jest.fn(), toggleFavorite: jest.fn(),
      addSoundpackGroup: jest.fn(), setNotice: jest.fn(), deleteSound: jest.fn(async () => true), renameSound: jest.fn(async () => true), reload: jest.fn(),
    } as unknown as SoundboardController;
    await render();
  }, 30_000);
  afterEach(async () => {if (renderer) await act(async () => renderer.unmount());});
  test('without voice, play is disabled but local groups and management remain accessible', async () => {
    await render(); expect(touch('播放语音包：长中文合成测试声音名称').props.disabled).toBe(true);
    expect(touch('添加语音包分组').props.disabled).toBe(false); await press('语音包操作：长中文合成测试声音名称');
    expect(button('重命名').props.disabled).toBe(false); await press('将长中文合成测试声音名称移到分组 2'); expect(board.moveSound).toHaveBeenCalledWith('a','two',1);
    await press('下移分组 1'); expect(board.swapGroups).toHaveBeenCalledWith('one','two');
  });
  test('server permission hides destructive controls for read-only packs', async () => {
    await render(); await press('语音包操作：只读声音'); expect(renderer.root.findAllByType(CoveButton).some(node => node.props.title === '删除语音包')).toBe(false);
    expect(button('下载原始音频')).toBeDefined();
  });
  test('downloads original audio using authorized custom-server path and suppresses repeats', async () => {
    await render(); await press('语音包操作：长中文合成测试声音名称'); const action = button('下载原始音频');
    await act(async () => {action.props.onPress(); action.props.onPress();});
    expect(saveSoundpack).toHaveBeenCalledTimes(1); expect(saveSoundpack).toHaveBeenCalledWith({url: 'http://fixture.test/cove/sounds/a.original.wav?synthetic-key=fixture', serverURL: 'http://fixture.test/cove', filename: '长中文合成测试声音名称.wav'});
  });
  test('rename supports long Chinese input and cancellation without changing the file', async () => {
    await render(); await press('语音包操作：长中文合成测试声音名称'); await act(async () => button('重命名').props.onPress());
    const field = renderer.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '语音包名称')!;
    expect(field.props.maxLength).toBe(64); await act(async () => field.props.onChangeText('修改后的合成语音包'));
    await act(async () => button('保存名称').props.onPress()); expect(board.renameSound).toHaveBeenCalledWith('a','修改后的合成语音包');
  });
  test('delete confirmation offers cancel and invokes existing server action only on delete', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(); await press('语音包操作：长中文合成测试声音名称'); await act(async () => button('删除语音包').props.onPress());
    expect(board.deleteSound).not.toHaveBeenCalled(); const actions = alert.mock.calls[0][2]!; expect(actions[0].style).toBe('cancel');
    await act(async () => actions[1].onPress!()); expect(board.deleteSound).toHaveBeenCalledWith('a'); alert.mockRestore();
  });
  test('closed panel unmounts import editor while controller is kept by its parent', async () => {
    await render(); expect(renderer.root.findAllByType('SoundpackImport' as any)).toHaveLength(1);
    visible = false; await render(); expect(renderer.toJSON()).toBeNull();
  });
});
