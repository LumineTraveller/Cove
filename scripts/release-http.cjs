#!/usr/bin/env node
'use strict';

const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function configuredProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || null;
}

async function main() {
  const [mode, url, userAgent, ...options] = process.argv.slice(2);
  const outputPath = mode === 'download' ? options[0] : undefined;
  const expectedSize = mode === 'head' ? options[0] : undefined;
  if (!['json', 'download', 'head'].includes(mode) || !url || !userAgent) {
    throw new Error('Usage: release-http.cjs <json|download|head> <url> <user-agent> [output-path] [expected-size]');
  }

  const proxy = configuredProxy();
  let dispatcher;
  if (proxy) {
    const { ProxyAgent } = require('undici');
    dispatcher = new ProxyAgent(proxy);
  }

  try {
    const method = mode === 'head' ? 'HEAD' : 'GET';
    const response = await fetch(url, {
      method,
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(mode === 'download' ? 300_000 : 20_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    if (mode === 'head' && response.status !== 200) throw new Error(`HTTP ${response.status}: ${url}`);

    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify(await response.json())}\n`);
      return;
    }
    if (mode === 'head') {
      const actualSize = response.headers.get('content-length');
      if (expectedSize && actualSize !== expectedSize) {
        throw new Error(`Content-Length ${actualSize} does not match ${expectedSize}: ${url}`);
      }
      process.stdout.write(`HTTP ${response.status}${actualSize ? `, ${actualSize} bytes` : ''}: ${url}\n`);
      return;
    }
    if (!outputPath || !response.body) throw new Error('Download requires a destination path and response body');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath, { flags: 'w' }));
  } finally {
    await dispatcher?.close();
  }
}

main().catch(error => {
  console.error(`[release-http] ${error.message}`);
  process.exitCode = 1;
});
