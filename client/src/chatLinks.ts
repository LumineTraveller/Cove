export interface ChatTextSegment {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

// 常见顶级域名：只有命中这些 TLD 的裸域名才会被识别，避免把 index.ts、1.5、
// foo.bar 之类的普通文本误判成链接。
const COMMON_TLDS = [
  'com', 'cn', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'me', 'cc',
  'tv', 'info', 'biz', 'top', 'xyz', 'site', 'online', 'shop', 'store', 'tech',
  'cloud', 'app', 'dev', 'ai', 'us', 'uk', 'jp', 'kr', 'de', 'fr', 'ru', 'au',
  'ca', 'sg', 'hk', 'tw', 'eu', 'in', 'br', 'it', 'es', 'nl', 'se', 'ch', 'be',
  'dk', 'pl', 'pt', 'cz', 'ie', 'nz', 'mx', 'ar', 'cl', 'id', 'th', 'vn', 'my',
  'ph', 'tr', 'za', 'il', 'sa', 'ae', 'ua', 'by', 'kz', 'pk', 'bd', 'lk', 'np',
  'kh', 'la', 'mn',
].join('|');

// URL 主体允许的字符：空白、尖括号、引号以及中日韩标点/全角符号都要截断，
// 否则“example.com/x，谢谢”会把后面的中文一起吞进链接。
const URL_TAIL = '[^\\s<>"\'\\u3000-\\u303f\\uff00-\\uffef]+';

// 三类链接，按优先级排列：带协议头、www 前缀、裸域名。
// 裸域名要求前面不是 @、单词字符、点、斜杠或反斜杠，避免匹配到邮箱和文件路径。
const LINK_PATTERN = new RegExp(
  [
    `https?:\\/\\/${URL_TAIL}`,
    `(?<![@\\w./\\\\-])www\\.(?:[a-z0-9-]+\\.)+[a-z0-9-]{2,}(?::\\d{1,5})?(?:\\/${URL_TAIL})?`,
    `(?<![@\\w./\\\\-])(?:[a-z0-9-]+\\.)+(?:${COMMON_TLDS})(?::\\d{1,5})?(?:\\/${URL_TAIL})?`,
  ].join('|'),
  'giu',
);

const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、）)\]}>】》]+$/u;

export function parseChatText(value: string): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let cursor = 0;

  for (const match of value.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: 'text', text: value.slice(cursor, index) });

    const raw = match[0];
    const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
    if (!trimmed) {
      segments.push({ kind: 'text', text: raw });
      cursor = index + raw.length;
      continue;
    }

    // 没有协议头的链接统一按 https 打开。
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    segments.push({ kind: 'link', text: trimmed, href });
    if (trimmed.length < raw.length)
      segments.push({ kind: 'text', text: raw.slice(trimmed.length) });
    cursor = index + raw.length;
  }

  if (cursor < value.length) segments.push({ kind: 'text', text: value.slice(cursor) });
  return segments.length ? segments : [{ kind: 'text', text: value }];
}
