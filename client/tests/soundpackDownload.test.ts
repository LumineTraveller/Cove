import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  soundpackDownloadFileName,
  soundpackDownloadName,
  soundpackExtension,
} from '../src/soundpackDownload';

test('download name keeps readable names untouched', () => {
  assert.equal(soundpackDownloadName('不惧坐牢', 'fallback'), '不惧坐牢');
  assert.equal(soundpackDownloadName('  hello world  ', 'fallback'), 'hello world');
});

test('download name replaces characters that are illegal on Windows', () => {
  assert.equal(soundpackDownloadName('a/b\\c:d*e?f"g<h>i|j', 'fallback'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(soundpackDownloadName('line\nbreak', 'fallback'), 'line_break');
});

test('download name trims trailing dots and spaces and caps the length', () => {
  assert.equal(soundpackDownloadName('name... ', 'fallback'), 'name');
  assert.equal(soundpackDownloadName('x'.repeat(200), 'fallback'), 'x'.repeat(60));
  // 截断后可能又落在点或空格上，需要再裁一次。
  assert.equal(soundpackDownloadName(`${'y'.repeat(59)}.z`, 'fallback'), 'y'.repeat(59));
});

test('download name falls back for empty names and escapes reserved device names', () => {
  assert.equal(soundpackDownloadName('   ', 'soundpack-abc'), 'soundpack-abc');
  // 全部是非法字符时会被替换成下划线，仍然是一个可用文件名，不需要回退。
  assert.equal(soundpackDownloadName('///', 'soundpack-abc'), '___');
  assert.equal(soundpackDownloadName('CON', 'fallback'), '_CON');
  assert.equal(soundpackDownloadName('lpt1', 'fallback'), '_lpt1');
  assert.equal(soundpackDownloadName('console', 'fallback'), 'console');
});

test('download extension follows the stored file and never invents a format', () => {
  assert.equal(soundpackExtension('h0zx1m2.ogg'), 'ogg');
  assert.equal(soundpackExtension('abc.MP3'), 'mp3');
  assert.equal(soundpackExtension('abc.wav'), 'wav');
  assert.equal(soundpackExtension('noextension'), 'mp3');
  assert.equal(soundpackExtension('weird.toolongext'), 'mp3');
});

test('download file name combines a safe name with the stored extension', () => {
  assert.equal(
    soundpackDownloadFileName('不惧坐牢', 'h0zx1m2.ogg', 'h0zx1m2'),
    '不惧坐牢.ogg',
  );
  assert.equal(soundpackDownloadFileName('  ', 'a.mp3', 'abc123'), 'soundpack-abc123.mp3');
});
