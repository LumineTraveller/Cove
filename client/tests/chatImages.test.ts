import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatImageMimeType,
  collectChatImageFiles,
  validateChatImageFile,
} from '../src/chatImages';

function file(name: string, type: string, size = 1024): File {
  return { name, type, size } as File;
}

test('clipboard image MIME types are preserved', () => {
  assert.equal(chatImageMimeType(file('image.png', 'image/png')), 'image/png');
  assert.equal(chatImageMimeType(file('photo.jpg', 'image/jpeg')), 'image/jpeg');
});

test('Windows drag files with an empty MIME type use their extension', () => {
  assert.equal(chatImageMimeType(file('screenshot.PNG', '')), 'image/png');
  assert.equal(chatImageMimeType(file('animation.gif', '')), 'image/gif');
});

test('drag and clipboard collections ignore non-image files', () => {
  const images = collectChatImageFiles({
    0: file('notes.txt', 'text/plain'),
    1: file('capture.png', 'image/png'),
    2: file('photo.webp', ''),
    length: 3,
  });
  assert.deepEqual(images.map(image => image.name), ['capture.png', 'photo.webp']);
});

test('unsupported and oversized images are rejected before upload', () => {
  assert.match(validateChatImageFile(file('photo.bmp', 'image/bmp')) ?? '', /仅支持/);
  assert.match(validateChatImageFile(file('large.png', 'image/png', 5 * 1024 * 1024 + 1)) ?? '', /5MB/);
  assert.equal(validateChatImageFile(file('valid.png', 'image/png')), null);
});
