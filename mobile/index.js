/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { registerGlobals } from 'react-native-webrtc';
import { name as appName } from './app.json';

// mediasoup-client 创建 Device 前必须先注册 React Native WebRTC 全局对象。
registerGlobals();
const App = require('./App').default;

AppRegistry.registerComponent(appName, () => App);
