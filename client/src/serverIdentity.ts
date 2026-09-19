import { normalizeServerSecurityURL } from './serverSecurity';

export interface ServerIdentity {
  originalUrl: string;
  key: string;
  addresses: string[];
}

export function canonicalIPv4(value: string): string | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some(number => !Number.isInteger(number) || number < 0 || number > 255)) return null;
  return numbers.join('.');
}

export function canonicalIPv6(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);
  input = input.split('%')[0] ?? '';
  if (!input || (input.match(/::/g) ?? []).length > 1) return null;

  let expanded = input;
  if (input.includes('.')) {
    const separator = input.lastIndexOf(':');
    const ipv4 = canonicalIPv4(input.slice(separator + 1));
    if (separator < 0 || !ipv4) return null;
    const octets = ipv4.split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    expanded = `${input.slice(0, separator + 1)}${high}:${low}`;
  }

  const [leftText, rightText] = expanded.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ((!expanded.includes('::') && !rightText && !leftText) || left.some(part => !/^[0-9a-f]{1,4}$/.test(part)) || right.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (expanded.includes('::') ? missing < 1 : missing !== 0) return null;
  const hextets = [...left, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...right]
    .map(part => Number.parseInt(part, 16));
  if (hextets.length !== 8 || hextets.some(part => !Number.isInteger(part))) return null;

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < hextets.length;) {
    if (hextets[index] !== 0) { index += 1; continue; }
    const start = index;
    while (index < hextets.length && hextets[index] === 0) index += 1;
    if (index - start > bestLength && index - start >= 2) {
      bestStart = start;
      bestLength = index - start;
    }
  }
  const formatted = hextets.map(part => part.toString(16));
  if (bestStart < 0) return formatted.join(':');
  const leftPart = formatted.slice(0, bestStart).join(':');
  const rightPart = formatted.slice(bestStart + bestLength).join(':');
  return `${leftPart}::${rightPart}`;
}

export function canonicalIP(value: string): string | null {
  return canonicalIPv4(value) ?? canonicalIPv6(value);
}

export function canonicalAddressSet(values: readonly string[]): string[] {
  const unique = new Set(values.map(canonicalIP).filter((value): value is string => !!value));
  return [...unique].sort((left, right) => {
    const leftV4 = left.includes('.') ? 0 : 1;
    const rightV4 = right.includes('.') ? 0 : 1;
    return leftV4 - rightV4 || left.localeCompare(right);
  });
}

function endpointSuffix(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${port}${pathname}`;
}

function fallbackKey(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return `host:${host}:${endpointSuffix(url)}`;
}

export function serverIdentityKey(url: string, addresses: readonly string[] = []): string {
  const normalized = canonicalAddressSet(addresses);
  const candidate = normalizeServerSecurityURL(url);
  try {
    const parsed = new URL(candidate);
    if (normalized.length) return `ip:${normalized.join(',')}|${endpointSuffix(parsed)}`;
    return fallbackKey(parsed);
  }
  catch { return `host:${candidate.toLowerCase()}`; }
}

export async function resolveServerIdentity(
  serverURL: string,
  resolver: (hostname: string) => Promise<string[]> = async hostname => {
    try { return await window.coveSecurity?.resolveServerAddresses(hostname) ?? []; }
    catch { return []; }
  },
): Promise<ServerIdentity> {
  const originalUrl = normalizeServerSecurityURL(serverURL);
  if (!originalUrl) return { originalUrl: serverURL, key: `host:${serverURL.trim().toLowerCase()}`, addresses: [] };
  const url = new URL(originalUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = canonicalIP(hostname);
  const addresses = literal ? [literal] : canonicalAddressSet(await resolver(hostname));
  return { originalUrl, key: serverIdentityKey(originalUrl, addresses), addresses };
}
