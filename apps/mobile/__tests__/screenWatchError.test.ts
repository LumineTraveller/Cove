import { screenWatchError } from '../src/features/media/screen/screenWatchError';

test('screen codec rejection gives an explicit compatible-viewing action without changing unrelated errors', () => {
  expect(screenWatchError(new Error('cannot consume'), true)).toContain('VP8');
  expect(screenWatchError(new Error('cannot consume'), false)).toBe('cannot consume');
  expect(screenWatchError(new Error('session ended'), true)).toBe('session ended');
});
