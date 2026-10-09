#!/usr/bin/env node
'use strict';

// Read the final APK directly, without Android tools, dependencies, or extraction.
// This gate covers only the known DNS Promise/List bridge regression. Signing and
// release metadata are checked separately by the existing release workflow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const MODULE = 'Lcom/covemobile/CoveNativeModule;';
const ARGUMENTS = 'Lcom/facebook/react/bridge/Arguments;';
const PROMISE = 'Lcom/facebook/react/bridge/Promise;';
const WRITABLE_ARRAY = 'Lcom/facebook/react/bridge/WritableArray;';

function apkEntries(bytes) {
  assert.ok(bytes.length >= 22, 'APK is too small to be a ZIP file');
  let end = bytes.length - 22;
  const lowerBound = Math.max(0, bytes.length - 65557);
  while (end >= lowerBound) {
    if (bytes.readUInt32LE(end) === 0x06054b50
      && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end--;
  }
  assert.ok(end >= lowerBound, 'APK ZIP directory is missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is unsupported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is unsupported');
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count, 'Inconsistent ZIP entry count');
  assert.notEqual(count, 0xffff, 'ZIP64 APK is unsupported');
  const entries = new Map();
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'Invalid ZIP directory entry');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(!entries.has(name), `Duplicate APK entry: ${name}`);
    entries.set(name, {
      flags: bytes.readUInt16LE(cursor + 8),
      compression: bytes.readUInt16LE(cursor + 10),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      size: bytes.readUInt32LE(cursor + 24),
      offset: bytes.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(bytes, entry) {
  assert.equal(entry.flags & 1, 0, 'Encrypted DEX entry is unsupported');
  assert.equal(bytes.readUInt32LE(entry.offset), 0x04034b50, 'Invalid ZIP local entry');
  const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26)
    + bytes.readUInt16LE(entry.offset + 28);
  assert.ok(start + entry.compressedSize <= bytes.length, 'Truncated APK entry');
  const payload = bytes.subarray(start, start + entry.compressedSize);
  assert.ok(entry.compression === 0 || entry.compression === 8, 'Unsupported ZIP compression');
  const result = entry.compression === 0 ? payload : zlib.inflateRawSync(payload);
  assert.equal(result.length, entry.size, 'DEX entry size does not match ZIP directory');
  return result;
}

function dnsMethods(bytes) {
  assert.match(bytes.subarray(0, 8).toString('ascii'), /^dex\n\d{3}\0$/, 'Invalid DEX magic');
  assert.equal(bytes.readUInt32LE(0x24), 112, 'Unsupported DEX header');
  assert.equal(bytes.readUInt32LE(0x28), 0x12345678, 'Unsupported DEX byte order');
  const u32 = offset => bytes.readUInt32LE(offset);
  const u16 = offset => bytes.readUInt16LE(offset);
  const leb = pointer => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      assert.ok(pointer.value < bytes.length, 'Truncated DEX ULEB128');
      const part = bytes[pointer.value++];
      assert.ok(i < 4 || (part & 0xf0) === 0, 'Invalid DEX ULEB128');
      value |= (part & 127) << (i * 7);
      if (!(part & 128)) return value >>> 0;
    }
    throw new Error('Invalid DEX ULEB128');
  };
  const strings = Array.from({ length: u32(0x38) }, (_, i) => {
    const pointer = { value: u32(u32(0x3c) + i * 4) };
    leb(pointer);
    const end = bytes.indexOf(0, pointer.value);
    assert.ok(end >= pointer.value, 'Unterminated DEX string');
    return bytes.subarray(pointer.value, end).toString('utf8');
  });
  const types = Array.from({ length: u32(0x40) }, (_, i) => strings[u32(u32(0x44) + i * 4)]);
  const method = index => {
    assert.ok(index < u32(0x58), 'Invalid DEX method index');
    const offset = u32(0x5c) + index * 8;
    const proto = u32(0x4c) + u16(offset + 2) * 12;
    const parameters = u32(proto + 8);
    return {
      type: types[u16(offset)], name: strings[u32(offset + 4)],
      returnType: types[u32(proto + 4)],
      parameterTypes: parameters
        ? Array.from({ length: u32(parameters) }, (_, i) => types[u16(parameters + 4 + i * 2)]) : [],
    };
  };

  // Standard DEX instruction widths; unknown opcodes fail closed. Only selected
  // product methods are decoded. See Android's dex-format and dalvik-bytecode.
  function instructions(code) {
    assert.ok(code > 0, 'DNS method has no DEX implementation');
    const length = u32(code + 12), start = code + 16, result = [];
    assert.ok(start + length * 2 <= bytes.length, 'Truncated DNS method');
    const wordAt = index => {
      assert.ok(index < length, 'Truncated DEX instruction');
      return u16(start + index * 2);
    };
    for (let i = 0; i < length;) {
      const word = wordAt(i), opcode = word & 255;
      const record = { offset: i, opcode };
      let width;
      if (opcode === 0 && word !== 0) {
        if (word === 0x100) width = 4 + wordAt(i + 1) * 2;
        else if (word === 0x200) width = 2 + wordAt(i + 1) * 4;
        else if (word === 0x300) {
          width = 4 + Math.ceil(wordAt(i + 1) * u32(start + (i + 2) * 2) / 2);
        } else throw new Error(`Unknown DEX payload at ${i}`);
      } else if ((opcode >= 0x6e && opcode <= 0x72) || (opcode >= 0x74 && opcode <= 0x78)) {
        width = 3;
        record.call = method(wordAt(i + 1));
        if (opcode <= 0x72) {
          const packed = wordAt(i + 2), count = word >>> 12;
          assert.ok(count <= 5, 'Invalid DEX invocation register count');
          record.registers = [packed & 15, (packed >>> 4) & 15, (packed >>> 8) & 15,
            (packed >>> 12) & 15, (word >>> 8) & 15].slice(0, count);
        } else {
          record.registers = Array.from({ length: word >>> 8 }, (_, j) => wordAt(i + 2) + j);
        }
      } else if (opcode === 0x18) width = 5;
      else if (opcode === 0xfa || opcode === 0xfb) width = 4;
      else if ([0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c, 0xfc, 0xfd].includes(opcode)) width = 3;
      else if ([0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29, 0xfe, 0xff].includes(opcode)
        || (opcode >= 0x2d && opcode <= 0x3d) || (opcode >= 0x44 && opcode <= 0x6d)
        || (opcode >= 0x90 && opcode <= 0xaf) || (opcode >= 0xd0 && opcode <= 0xe2)) width = 2;
      else if ([0x00, 0x01, 0x04, 0x07, 0x1d, 0x1e, 0x21, 0x27, 0x28].includes(opcode)
        || (opcode >= 0x0a && opcode <= 0x12) || (opcode >= 0x7b && opcode <= 0x8f)
        || (opcode >= 0xb0 && opcode <= 0xcf)) width = 1;
      else throw new Error(`Unsupported DEX opcode 0x${opcode.toString(16)} at ${i}`);
      if (opcode === 0x0c) record.resultRegister = word >>> 8;
      assert.ok(i + width <= length, 'Invalid DEX instruction width');
      result.push(record);
      i += width;
    }
    return result;
  }

  const selected = [];
  let found = false;
  for (let i = 0; i < u32(0x60); i++) {
    const offset = u32(0x64) + i * 32;
    if (types[u32(offset)] !== MODULE) continue;
    assert.equal(found, false, 'Duplicate CoveNativeModule class');
    found = true;
    const pointer = { value: u32(offset + 24) };
    assert.ok(pointer.value > 0, 'CoveNativeModule has no class data');
    const staticFields = leb(pointer), instanceFields = leb(pointer);
    const directMethods = leb(pointer), virtualMethods = leb(pointer);
    for (let field = 0; field < staticFields + instanceFields; field++) { leb(pointer); leb(pointer); }
    for (const count of [directMethods, virtualMethods]) {
      let index = 0;
      for (let j = 0; j < count; j++) {
        index += leb(pointer); leb(pointer); const code = leb(pointer);
        const reference = method(index);
        if (reference.name === 'resolveServerAddresses' || /^resolveServerAddresses\$lambda\$\d+$/.test(reference.name)) {
          assert.equal(reference.type, MODULE, 'DNS method belongs to a different class');
          selected.push({ name: reference.name, instructions: instructions(code) });
        }
      }
    }
  }
  return { found, selected };
}

function verify(apk) {
  const bytes = fs.readFileSync(apk), entries = apkEntries(bytes), selected = [];
  let moduleCount = 0;
  for (const [name, entry] of entries) {
    if (!/^classes\d*\.dex$/.test(name)) continue;
    const parsed = dnsMethods(readEntry(bytes, entry));
    if (parsed.found) moduleCount++;
    selected.push(...parsed.selected);
  }
  assert.equal(moduleCount, 1, 'Expected one packaged CoveNativeModule class');
  assert.ok(selected.some(item => item.name === 'resolveServerAddresses'), 'DNS entry method is missing');
  assert.ok(selected.some(item => item.name.startsWith('resolveServerAddresses$lambda$')), 'DNS worker lambda is missing');
  const counts = { fromList: 0, createArray: 0, promiseResolve: 0 };
  const flows = [];
  for (const item of selected) {
    const instructions = item.instructions;
    for (let i = 0; i < instructions.length; i++) {
      const current = instructions[i], call = current.call;
      if (call?.type === ARGUMENTS && ['fromList', 'createArray'].includes(call.name)) counts[call.name]++;
      if (call?.type !== PROMISE || call.name !== 'resolve') continue;
      counts.promiseResolve++;
      const conversion = instructions[i - 2], move = instructions[i - 1];
      const context = `${item.name} at DEX instruction ${current.offset}`;
      assert.ok(conversion?.call?.type === ARGUMENTS
        && ['fromList', 'createArray'].includes(conversion.call.name), `${context}: Promise.resolve lacks a WritableArray conversion`);
      assert.ok(conversion.opcode === 0x71 || conversion.opcode === 0x77, `${context}: array conversion must be static`);
      assert.equal(conversion.call.returnType, WRITABLE_ARRAY, `${context}: conversion must return WritableArray`);
      assert.deepEqual(conversion.call.parameterTypes, conversion.call.name === 'fromList' ? ['Ljava/util/List;'] : [], `${context}: unexpected conversion signature`);
      assert.equal(move.opcode, 0x0c, `${context}: array conversion result is not captured`);
      assert.equal(current.registers.length, 2, `${context}: unexpected Promise.resolve arguments`);
      assert.equal(current.registers[1], move.resultRegister, `${context}: Promise.resolve does not receive the converted array`);
      assert.deepEqual(call.parameterTypes, ['Ljava/lang/Object;'], `${context}: unexpected Promise.resolve signature`);
      flows.push({ method: item.name, conversion: conversion.call.name, resultRegister: move.resultRegister });
    }
  }
  assert.deepEqual(counts, { fromList: 1, createArray: 2, promiseResolve: 3 }, 'Expected all three DNS Promise paths to use bridge arrays');
  return {
    verified: true, apk, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    module: MODULE, counts, flows,
  };
}

if (process.argv.length !== 3) {
  console.error('Usage: node verify-native-release.cjs <release.apk>');
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(verify(path.resolve(process.argv[2])), null, 2));
  } catch (error) {
    console.error(`Native DNS release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
