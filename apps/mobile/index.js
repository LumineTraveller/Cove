/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { registerGlobals } from 'react-native-webrtc';
import { name as appName } from './app.json';

// mediasoup-client 创建 Device 前必须先注册 React Native WebRTC 全局对象。
registerGlobals();

// ── Bridgeless 模式 TurboModule 初始化竞态保护 ──────────────────────────────
// RN 0.85 Bridgeless 模式下，JS bundle 可能在 TurboModule 注册完成前开始执行。
// 此时 getEnforcing('PlatformConstants') 会 throw → SIGABRT → 闪退。
// 用安全代理兜底，待真实模块注册后自然恢复。
const TurboModuleRegistry = require('react-native/Libraries/TurboModule/TurboModuleRegistry');
if (TurboModuleRegistry?.getEnforcing) {
  const originalGetEnforcing = TurboModuleRegistry.getEnforcing;
  TurboModuleRegistry.getEnforcing = function (name) {
    try {
      return originalGetEnforcing.call(this, name);
    } catch (_) {
      console.warn(`[cove] TurboModule '${name}' 尚未注册，使用安全代理兜底`);
      return new Proxy({}, {
        get: (_target, prop) => {
          if (prop === 'getConstants') return () => ({});
          return () => undefined;
        },
      });
    }
  };
}

const App = require('./App').default;

AppRegistry.registerComponent(appName, () => App);
