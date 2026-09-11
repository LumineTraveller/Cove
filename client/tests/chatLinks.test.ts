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

test('www-prefixed addresses become https links', () => {
  assert.deepEqual(parseChatText('去 www.baidu.com 看看'), [
    { kind: 'text', text: '去 ' },
    { kind: 'link', text: 'www.baidu.com', href: 'https://www.baidu.com' },
    { kind: 'text', text: ' 看看' },
  ]);
  assert.deepEqual(parseChatText('WWW.Example.COM/a。'), [
    { kind: 'link', text: 'WWW.Example.COM/a', href: 'https://WWW.Example.COM/a' },
    { kind: 'text', text: '。' },
  ]);
});

test('bare domains with common TLDs become https links', () => {
  assert.deepEqual(parseChatText('baidu.com/s?wd=cove'), [
    { kind: 'link', text: 'baidu.com/s?wd=cove', href: 'https://baidu.com/s?wd=cove' },
  ]);
  assert.deepEqual(parseChatText('打开 example.com:8080/x，谢谢'), [
    { kind: 'text', text: '打开 ' },
    { kind: 'link', text: 'example.com:8080/x', href: 'https://example.com:8080/x' },
    { kind: 'text', text: '，谢谢' },
  ]);
});

test('dotted text, emails and file paths stay plain', () => {
  assert.deepEqual(parseChatText('index.ts 和 1.5 和 foo.bar'), [
    { kind: 'text', text: 'index.ts 和 1.5 和 foo.bar' },
  ]);
  assert.deepEqual(parseChatText('mail: user@example.com'), [
    { kind: 'text', text: 'mail: user@example.com' },
  ]);
  assert.deepEqual(parseChatText('路径 src/index.com/x'), [
    { kind: 'text', text: '路径 src/index.com/x' },
  ]);
});

test('external URL gate accepts only absolute HTTP and HTTPS URLs', () => {
  assert.equal(normalizeExternalHttpUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeExternalHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeExternalHttpUrl('javascript:alert(1)'), null);
  assert.equal(normalizeExternalHttpUrl('file:///C:/Windows/System32'), null);
  assert.equal(normalizeExternalHttpUrl('/relative/path'), null);
});
