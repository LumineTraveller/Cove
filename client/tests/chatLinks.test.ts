import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalHttpUrl } from '../electron/external-links';
import { parseChatText } from '../src/chatLinks';

test('chat text preserves newlines and recognizes HTTP(S) links', () => {
  assert.deepEqual(parseChatText('第一行\nhttps://example.com/a?q=1\n第三行'), [
    { kind: 'text', text: '第一行\n' },
    { kind: 'link', text: 'https://example.com/a?q=1', href: 'https://example.com/a?q=1' },
    { kind: 'text', text: '\n第三行' },
  ]);
});

test('sentence punctuation is not included in the link target', () => {
  assert.deepEqual(parseChatText('查看 https://example.com/test。'), [
    { kind: 'text', text: '查看 ' },
    { kind: 'link', text: 'https://example.com/test', href: 'https://example.com/test' },
    { kind: 'text', text: '。' },
  ]);
});

test('external URL gate accepts only absolute HTTP and HTTPS URLs', () => {
  assert.equal(normalizeExternalHttpUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeExternalHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeExternalHttpUrl('javascript:alert(1)'), null);
  assert.equal(normalizeExternalHttpUrl('file:///C:/Windows/System32'), null);
  assert.equal(normalizeExternalHttpUrl('/relative/path'), null);
});
