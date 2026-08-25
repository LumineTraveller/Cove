export interface ChatTextSegment {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

const HTTP_LINK = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、）)\]}>】》]+$/u;

export function parseChatText(value: string): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let cursor = 0;

  for (const match of value.matchAll(HTTP_LINK)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: 'text', text: value.slice(cursor, index) });

    const raw = match[0];
    const href = raw.replace(TRAILING_PUNCTUATION, '');
    if (!href) {
      segments.push({ kind: 'text', text: raw });
      cursor = index + raw.length;
      continue;
    }

    segments.push({ kind: 'link', text: href, href });
    if (href.length < raw.length)
      segments.push({ kind: 'text', text: raw.slice(href.length) });
    cursor = index + raw.length;
  }

  if (cursor < value.length) segments.push({ kind: 'text', text: value.slice(cursor) });
  return segments.length ? segments : [{ kind: 'text', text: value }];
}
