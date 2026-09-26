import { avatarCropPresentation, avatarImageSource } from '../src/avatarCrop';

test('plain avatars pass through unchanged', () => {
  expect(avatarCropPresentation('data:image/png;base64,abc')).toBe(null);
  expect(avatarImageSource('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  expect(avatarImageSource(null)).toBe(null);
});

test('crop metadata is stripped and clamped for display', () => {
  const presentation = avatarCropPresentation('data:image/webp;base64,xyz#cove-crop=0.25,-2,1.8');
  expect(presentation).toEqual({
    source: 'data:image/webp;base64,xyz',
    offsetX: 0.25,
    offsetY: -1,
    zoom: 1.8,
  });
  expect(avatarImageSource('data:image/webp;base64,xyz#cove-crop=0.25,-2,1.8')).toBe('data:image/webp;base64,xyz');
});

test('invalid crop metadata is ignored', () => {
  expect(avatarCropPresentation('data:image/png;base64,abc#cove-crop=bad,input')).toBe(null);
  expect(avatarImageSource('data:image/png;base64,abc#cove-crop=bad,input')).toBe('data:image/png;base64,abc#cove-crop=bad,input');
});
