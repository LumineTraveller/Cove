import { NativeModules, Platform } from 'react-native';

export const MAX_SOUNDPACK_BYTES = 8 * 1024 * 1024;
export interface SoundpackAudioFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uri: string;
  duration: number;
}
export interface SoundpackAudioRead {
  data: string;
  mimeType: string;
  size: number;
  duration: number;
  uri: string;
}
export interface SoundpackSaveOptions {
  url: string;
  filename: string;
  serverURL: string;
}
export interface SoundpackSaveResult {
  cancelled: boolean;
  filename?: string;
}
interface SoundpackFilesNative {
  pickAudioFiles(): Promise<SoundpackAudioFile[]>;
  readAudioSelection(
    id: string,
    startSeconds: number,
    endSeconds: number,
  ): Promise<SoundpackAudioRead>;
  releaseAudioFiles(ids: string[]): Promise<void>;
  saveSoundpack(options: SoundpackSaveOptions): Promise<SoundpackSaveResult>;
  cancelOperations(): Promise<void>;
  saveTextFile(text: string, fileName: string): Promise<boolean>;
}

function native(): SoundpackFilesNative {
  const module =
    Platform.OS === 'android' ? NativeModules.CoveSoundpacks : undefined;
  if (!module)
    throw new Error('当前安装包不支持系统音频文件选择，请更新测试安装包。');
  return module;
}

function validAudio(file: SoundpackAudioFile) {
  return (
    !!file &&
    typeof file.id === 'string' &&
    file.id.length > 0 &&
    typeof file.name === 'string' &&
    typeof file.mimeType === 'string' &&
    file.mimeType.startsWith('audio/') &&
    typeof file.uri === 'string' &&
    file.uri.startsWith('file://') &&
    Number.isFinite(file.size) &&
    file.size > 0 &&
    file.size <= MAX_SOUNDPACK_BYTES &&
    Number.isFinite(file.duration) &&
    file.duration > 0
  );
}

/** Cancellation returns an empty list; unsupported documents fail visibly. */
export async function pickAudioFiles(): Promise<SoundpackAudioFile[]> {
  const module = native();
  const files = await module.pickAudioFiles();
  if (
    !Array.isArray(files) ||
    files.length > 20 ||
    files.some(file => !validAudio(file)) ||
    new Set(files.map(file => file.id)).size !== files.length
  ) {
    if (Array.isArray(files)) {
      await module.releaseAudioFiles(
        files.filter(file => typeof file?.id === 'string').map(file => file.id),
      );
    }
    throw new Error('音频文件信息无效，请重新选择。');
  }
  return files;
}

export async function readAudioSelection(
  id: string,
  startSeconds: number,
  endSeconds: number,
): Promise<SoundpackAudioRead> {
  if (
    !id ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    (endSeconds > 0 && endSeconds <= startSeconds)
  )
    throw new Error('请设置有效的音频裁剪范围。');
  const result = await native().readAudioSelection(
    id,
    startSeconds,
    endSeconds,
  );
  if (
    !result ||
    typeof result.data !== 'string' ||
    result.data.length === 0 ||
    !result.mimeType?.startsWith('audio/') ||
    !Number.isFinite(result.size) ||
    result.size <= 0 ||
    result.size > MAX_SOUNDPACK_BYTES ||
    !Number.isFinite(result.duration) ||
    result.duration <= 0 ||
    typeof result.uri !== 'string' ||
    !result.uri.startsWith('file://')
  )
    throw new Error('无法读取有效的音频内容。');
  return result;
}

export async function releaseAudioFiles(ids: string[]): Promise<void> {
  if (ids.length) await native().releaseAudioFiles([...new Set(ids)]);
}

export async function saveSoundpack(
  options: SoundpackSaveOptions,
): Promise<SoundpackSaveResult> {
  if (!options.url || !options.filename || !options.serverURL)
    throw new Error('下载地址或文件名无效。');
  return native().saveSoundpack(options);
}

export async function saveTextFile(
  text: string,
  fileName: string,
): Promise<boolean> {
  const controlCharacter = [...fileName].some(
    character =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (
    !text ||
    !/\.(json|txt)$/i.test(fileName) ||
    /[\\/:*?"<>|]/.test(fileName) ||
    controlCharacter
  ) {
    throw new Error('请选择有效的 JSON 或 TXT 文件名。');
  }
  return native().saveTextFile(text, fileName);
}

/** Safe on unsupported builds so closing a screen can always revoke its JS session. */
export async function cancelOperations(): Promise<void> {
  if (Platform.OS === 'android' && NativeModules.CoveSoundpacks) {
    await (
      NativeModules.CoveSoundpacks as SoundpackFilesNative
    ).cancelOperations();
  }
}
