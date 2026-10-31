'use strict';
// Pure CPU reference, serialized into the owned renderer with the probe.
// Constants and arithmetic are pinned to Chromium 152's libyuv dependency,
// source/row_common.cc: kYuvH709Constants + YuvPixel, x86/x64 limited BT709.
// This does not change shader coefficients or native-plane validation.
module.exports=function createReadbackColorOracle() {
  const revision='b56492e2dfc064f65ef27fed9c45d9bbfc2e2ad2';
  const constants=Object.freeze({UB:128,UG:14,VG:34,VR:115,YG:18997,YB:-1160});
  const clamp=value=>Math.max(0,Math.min(255,value));
  function nv12ToRgba(y,u,v) {
    const luma=Math.floor(y*257*constants.YG/65536)+constants.YB;
    const cb=u-128,cr=v-128;
    return [clamp(Math.floor((luma+cr*constants.VR)/64)),
      clamp(Math.floor((luma-cb*constants.UG-cr*constants.VG)/64)),
      clamp(Math.floor((luma+cb*constants.UB)/64)),255];
  }
  return {id:'libyuv-h709-x86-integer-v1',revision,constants,nv12ToRgba,
    source:`https://chromium.googlesource.com/libyuv/libyuv/+/${revision}/source/row_common.cc`,
    sourceSha256:'6fdd463fd0d944e29df7f439b92376ab143e168e4a328d13758495a895f05cfd',
    sourceHashObject:'raw Gitiles base64-decoded source bytes, LF line endings',
    localCrlfSnapshotSha256:'59da5636043ccfa4a77324d95f75b7ca6e8fb52ad3a3579fe9ae0c986cba55e7',
    dependencySource:'https://raw.githubusercontent.com/chromium/chromium/152.0.7977.54/DEPS'};
};
