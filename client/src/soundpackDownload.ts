/**
 * 语音包下载的文件名规则。
 *
 * 服务端把上传的音频原样存放在 /sounds 下，不转码，所以下载时保留原始扩展名
 * （上传 mp3 得到 .mp3，上传 ogg 得到 .ogg）。文件名取自语音包显示名，
 * 因此必须清理 Windows 不允许的字符、结尾点/空格与保留设备名。
 */

// Windows 保留设备名不能作为文件名（不区分大小写，且带扩展名也不行）。
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_NAME_LENGTH = 60;
const DEFAULT_EXTENSION = "mp3";

export function soundpackDownloadName(name: string, fallback: string): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    // Windows 不允许文件名以点或空格结尾。
    .replace(/[. ]+$/, "");
  if (!cleaned) return fallback;
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function soundpackExtension(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]{1,5}$/.test(extension) ? extension : DEFAULT_EXTENSION;
}

export function soundpackDownloadFileName(
  name: string,
  filename: string,
  fallbackId: string,
): string {
  return `${soundpackDownloadName(name, `soundpack-${fallbackId}`)}.${soundpackExtension(filename)}`;
}
