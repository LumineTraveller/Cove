export type RemoteControlInput =
  | { type: 'pointer'; x: number; y: number }
  | {
      type: 'button';
      button: RemoteMouseButton;
      down: boolean;
      x: number;
      y: number;
    }
  | { type: 'wheel'; deltaX: number; deltaY: number; x: number; y: number }
  | { type: 'key'; code: string; down: boolean };
export type RemoteMouseButton = 'left' | 'right' | 'middle';
export interface RemotePoint {
  x: number;
  y: number;
}

// Keep touch traffic below the shared server's 240 input/s budget. Keyboard
// and button edges never enter this throttle and flush the final position.
export const MOBILE_REMOTE_POINTER_INTERVAL_MS = 16;
const SAFE_KEY_CODE =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;
export const isRemoteKeyCode = (code: string) => SAFE_KEY_CODE.test(code);
export const isRemotePoint = (point: RemotePoint) =>
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  point.x >= 0 &&
  point.x <= 1 &&
  point.y >= 0 &&
  point.y <= 1;

/** A shortcut presses in order, then releases in reverse order. */
export function remoteShortcut(codes: readonly string[]): RemoteControlInput[] {
  if (
    !codes.length ||
    codes.length > 8 ||
    codes.some(code => !isRemoteKeyCode(code))
  )
    return [];
  const unique = [...new Set(codes)];
  return [
    ...unique.map(code => ({ type: 'key' as const, code, down: true })),
    ...unique
      .reverse()
      .map(code => ({ type: 'key' as const, code, down: false })),
  ];
}

export function remoteWheel(
  point: RemotePoint,
  deltaX: number,
  deltaY: number,
): RemoteControlInput | null {
  if (
    !isRemotePoint(point) ||
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY)
  )
    return null;
  return {
    type: 'wheel',
    ...point,
    deltaX: Math.max(-1200, Math.min(1200, deltaX)),
    deltaY: Math.max(-1200, Math.min(1200, deltaY)),
  };
}

/** Converts physical keyboard text only when the wire protocol can represent it.
 * Arbitrary Unicode/IME text is deliberately not fabricated as key codes. */
export function remoteCharacterKeys(character: string): string[] | null {
  if (/^[a-z]$/.test(character)) return [`Key${character.toUpperCase()}`];
  if (/^[A-Z]$/.test(character)) return ['ShiftLeft', `Key${character}`];
  if (/^[0-9]$/.test(character)) return [`Digit${character}`];
  const plain: Record<string, string> = {
    ' ': 'Space',
    '\n': 'Enter',
    '\t': 'Tab',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '`': 'Backquote',
  };
  if (plain[character]) return [plain[character]];
  const shifted: Record<string, string> = {
    '!': 'Digit1',
    '@': 'Digit2',
    '#': 'Digit3',
    $: 'Digit4',
    '%': 'Digit5',
    '^': 'Digit6',
    '&': 'Digit7',
    '*': 'Digit8',
    '(': 'Digit9',
    ')': 'Digit0',
    _: 'Minus',
    '+': 'Equal',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '|': 'Backslash',
    ':': 'Semicolon',
    '"': 'Quote',
    '<': 'Comma',
    '>': 'Period',
    '?': 'Slash',
    '~': 'Backquote',
  };
  return shifted[character] ? ['ShiftLeft', shifted[character]] : null;
}

/** All-or-nothing mapping. No silent Unicode loss or clipboard access. */
export function textToRemoteInputs(text: string): RemoteControlInput[] | null {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized || normalized.length > 256) return null;
  const inputs: RemoteControlInput[] = [];
  for (const character of normalized) {
    const codes = remoteCharacterKeys(character);
    if (!codes) return null;
    inputs.push(...remoteShortcut(codes));
  }
  return inputs;
}
