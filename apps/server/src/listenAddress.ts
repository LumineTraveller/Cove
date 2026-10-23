import { isIP } from 'node:net';

/** Bind addresses never perform DNS lookup; unset retains the existing IPv4 default. */
export function readListenAddress(value: string | undefined, name: string): string {
  if (value === undefined) return '0.0.0.0';
  const address = value.trim();
  if (!isIP(address)) throw new Error(`${name} must be an IPv4 or IPv6 address`);
  return address;
}
