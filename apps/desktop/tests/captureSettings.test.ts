import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type SettingsProps = Parameters<
  typeof import('../src/features/settings/components/GlobalSettingsV2').GlobalSettingsV2
>[0];

const noop = () => {};

test('capture settings own the single compatibility choice and preserve the active-share lock', async t => {
  // Vite loads these two styles in the app; this isolated server-render test only
  // needs their module identities, without installing a global CSS handler.
  const require = createRequire(__filename);
  const modules = [
    ['../src/styles/ui-v2.css', {}],
    ['../src/features/integrity/installation-integrity.css', {}],
    // Importing Avatar also imports the app socket; keep this render fixture
    // independent of browser storage and any user's server connection.
    ['../src/features/connection/socket', { getServerURL: () => 'https://example.test' }],
  ] as const;
  for (const [modulePath, exports] of modules) {
    const key = require.resolve(modulePath);
    const previous = require.cache[key];
    require.cache[key] = { id: key, filename: key, loaded: true, exports } as NodeModule;
    t.after(() => { if (previous) require.cache[key] = previous; else delete require.cache[key]; });
  }
  const { GlobalSettingsV2 } = await import('../src/features/settings/components/GlobalSettingsV2');
  for (const enabled of [false, true]) {
    for (const sharing of [false, true]) {
      const rtc = {
        selectedAudioInputId: 'default',
        selectedAudioOutputId: 'default',
        audioInputDevices: [],
        audioOutputDevices: [],
        microphoneNoiseMode: 'system',
        screenCompatibilityMode: enabled,
        setScreenCompatibilityMode: noop,
        isSharing: sharing,
      } as unknown as SettingsProps['rtc'];
      const markup = renderToStaticMarkup(createElement(GlobalSettingsV2, {
        profile: { username: '测试用户', avatarUrl: null },
        accountId: 'test-account',
        onProfileChange: noop,
        onLogout: noop,
        serverURL: 'https://example.test',
        inputVolume: 100,
        outputVolume: 100,
        setInputVolume: noop,
        setOutputVolume: noop,
        rtc,
        onClose: noop,
        theme: 'light',
        onThemeChange: noop,
      }));
      const controls = markup.match(/<input[^>]*aria-label="兼容观看（VP8）"[^>]*>/g) ?? [];
      assert.equal(controls.length, 1);
      assert.equal(controls[0].includes('checked='), enabled);
      assert.equal(controls[0].includes('disabled='), sharing);
      assert.match(markup, /采集设置/);
      assert.doesNotMatch(markup, /音频设备/);
      assert.match(markup, /下次共享/);
      if (sharing) assert.match(markup, /停止当前共享后可更改编码模式/);
      assert.match(markup, /默认输入设备/);
      assert.match(markup, /默认输出设备/);
      assert.match(markup, /麦克风降噪/);
    }
  }
});
