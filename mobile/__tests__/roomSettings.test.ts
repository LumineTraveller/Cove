import { roomLimit, roomPassword, roomSettingsPayload } from '../src/roomSettings';

test('roomLimit rejects invalid values instead of falling back', () => {
  expect(() => roomLimit('abc')).toThrow();
  expect(() => roomLimit('0')).toThrow();
  expect(() => roomLimit('1001')).toThrow();
  expect(roomLimit('')).toBeNull();
});

test('roomPassword preserves exact nonblank password and rejects blank/oversized', () => {
  expect(roomPassword(' pass ')).toBe(' pass ');
  expect(roomPassword('')).toBeUndefined();
  expect(() => roomPassword('   ')).toThrow();
  expect(() => roomPassword('x'.repeat(129))).toThrow();
});

test('roomSettingsPayload distinguishes keep-password from clear-password', () => {
  expect(roomSettingsPayload('r', '5', '')).toEqual({ roomId: 'r', maxMembers: 5, password: undefined });
  expect(roomSettingsPayload('r', '', '', true)).toEqual({ roomId: 'r', maxMembers: null, password: null });
  expect(roomSettingsPayload('r', '20', 'new secret')).toEqual({ roomId: 'r', maxMembers: 20, password: 'new secret' });
});
