import { NativeModules, Platform } from 'react-native';
import {
  cancelOperations,
  MAX_SOUNDPACK_BYTES,
  pickAudioFiles,
  readAudioSelection,
  releaseAudioFiles,
  saveSoundpack,
  saveTextFile,
} from '../src/features/soundpacks/soundpackFiles';

const file = {
  id: 'synthetic-id',
  name: '测试.wav',
  mimeType: 'audio/wav',
  size: 52,
  uri: 'file:///private/cache/synthetic.wav',
  duration: 1,
};
const bridge = {
  pickAudioFiles: jest.fn(),
  readAudioSelection: jest.fn(),
  releaseAudioFiles: jest.fn(),
  saveSoundpack: jest.fn(),
  cancelOperations: jest.fn(),
  saveTextFile: jest.fn(),
};

beforeEach(() => {
  Platform.OS = 'android';
  NativeModules.CoveSoundpacks = bridge;
  for (const method of Object.values(bridge)) method.mockReset();
  bridge.releaseAudioFiles.mockResolvedValue(undefined);
  bridge.cancelOperations.mockResolvedValue(undefined);
});

it('uses the system multi-selection and handles user cancellation without importing', async () => {
  bridge.pickAudioFiles.mockResolvedValueOnce([file]).mockResolvedValueOnce([]);
  await expect(pickAudioFiles()).resolves.toEqual([file]);
  await expect(pickAudioFiles()).resolves.toEqual([]);
  expect(bridge.pickAudioFiles).toHaveBeenCalledTimes(2);
});

it.each(
  [
    [{ ...file, size: MAX_SOUNDPACK_BYTES + 1 }],
    [{ ...file, duration: 0 }],
    [{ ...file, mimeType: 'image/png' }],
    [{ ...file, uri: 'content://not-private' }],
    [file, file],
    [null],
    Array.from({ length: 21 }, (_, i) => ({ ...file, id: String(i) })),
  ].map(files => ({ files })),
)(
  'releases malformed, oversized or duplicate native selections',
  async ({ files }) => {
    bridge.pickAudioFiles.mockResolvedValue(files);
    await expect(pickAudioFiles()).rejects.toThrow('音频文件信息无效');
    expect(bridge.releaseAudioFiles).toHaveBeenCalled();
  },
);

it('passes exact trim bounds and accepts full-selection original MIME', async () => {
  const read = {
    data: 'synthetic-base64',
    mimeType: 'audio/mpeg',
    size: 12,
    duration: 1,
    uri: file.uri,
  };
  bridge.readAudioSelection.mockResolvedValue(read);
  await expect(readAudioSelection(file.id, 0.25, 0.75)).resolves.toEqual(read);
  expect(bridge.readAudioSelection).toHaveBeenCalledWith(file.id, 0.25, 0.75);
  await expect(readAudioSelection(file.id, 0, 0)).resolves.toEqual(read);
});

it.each([
  [NaN, 1],
  [-1, 1],
  [1, 1],
  [2, 1],
  [0, Infinity],
])('rejects invalid trim ranges before native decoding', async (start, end) => {
  await expect(readAudioSelection(file.id, start, end)).rejects.toThrow(
    '裁剪范围',
  );
  expect(bridge.readAudioSelection).not.toHaveBeenCalled();
});

it('keeps oversize decoded output from entering upload', async () => {
  bridge.readAudioSelection.mockResolvedValue({
    data: 'x',
    mimeType: 'audio/wav',
    size: MAX_SOUNDPACK_BYTES + 1,
    duration: 1,
    uri: file.uri,
  });
  await expect(readAudioSelection(file.id, 0, 1)).rejects.toThrow('无法读取');
});

it('sends the original download filename and current server scope, including query tokens', async () => {
  const options = {
    serverURL: 'https://synthetic.test/cove',
    url: 'https://synthetic.test/cove/sounds/original.mp3?access_token=synthetic',
    filename: '测试.mp3',
  };
  bridge.saveSoundpack.mockResolvedValue({ cancelled: true });
  await expect(saveSoundpack(options)).resolves.toEqual({ cancelled: true });
  expect(bridge.saveSoundpack).toHaveBeenCalledWith(options);
});

it('deduplicates releases and propagates document-provider failures visibly', async () => {
  await releaseAudioFiles([file.id, file.id]);
  expect(bridge.releaseAudioFiles).toHaveBeenCalledWith([file.id]);
  bridge.pickAudioFiles.mockRejectedValue(
    new Error('The document provider cannot read this file'),
  );
  await expect(pickAudioFiles()).rejects.toThrow('document provider');
});

it('revokes native work on cancellation and lets old builds safely close a screen', async () => {
  await cancelOperations();
  expect(bridge.cancelOperations).toHaveBeenCalledTimes(1);
  delete NativeModules.CoveSoundpacks;
  await expect(cancelOperations()).resolves.toBeUndefined();
  await expect(pickAudioFiles()).rejects.toThrow('当前安装包不支持');
  Platform.OS = 'ios';
  await expect(
    saveSoundpack({
      url: 'https://s.test/sounds/x',
      serverURL: 'https://s.test',
      filename: 'x',
    }),
  ).rejects.toThrow('当前安装包不支持');
});

it('exports diagnostic JSON only through a user-selected system document', async () => {
  bridge.saveTextFile.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    saveTextFile('{"synthetic":true}', 'cove-diagnostics.json'),
  ).resolves.toBe(true);
  await expect(saveTextFile('synthetic', 'cove-diagnostics.txt')).resolves.toBe(
    false,
  );
  expect(bridge.saveTextFile).toHaveBeenCalledWith(
    '{"synthetic":true}',
    'cove-diagnostics.json',
  );
  await expect(saveTextFile('synthetic', '../private.json')).rejects.toThrow(
    '有效',
  );
  await expect(saveTextFile('synthetic', 'diagnostics.apk')).rejects.toThrow(
    '有效',
  );
});
