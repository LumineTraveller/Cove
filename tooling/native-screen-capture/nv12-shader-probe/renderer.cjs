'use strict';

// This function is serialized into a real sandboxed renderer. Keep it entirely
// self-contained: no require(), IPC, handles, pixels in results, or mock frames.
module.exports = function setup(requestId, options = {}) {
  const useNativeCopyFormat = options.cpuFrameNativeFormat === true;
  const useCpuFrame = options.cpuFrame === true || useNativeCopyFormat;
  const processorAvailable = typeof MediaStreamTrackProcessor === 'function';
  const generatorAvailable = typeof MediaStreamTrackGenerator === 'function';
  const bridge = window.coveNativeScreen;
  const supported = !!(bridge && bridge.supported && typeof bridge.onFrame === 'function' && generatorAvailable);
  const state = { status: 'waiting', result: null, errorCode: null };
  window.__coveNv12Probe = state;
  let unsubscribe;
  let active;
  let closed = false;
  const knownCodes = new Set([
    'renderer_probe_cancelled', 'renderer_duplicate_frame', 'renderer_frame_api_invalid',
    'renderer_frame_metadata_mismatch', 'renderer_frame_color_space_mismatch',
    'renderer_rgb_copy_failed', 'renderer_rgb_copy_timeout', 'renderer_rgb_layout_invalid',
    'renderer_rgb_marker_mismatch', 'renderer_generator_create_failed', 'renderer_generator_api_invalid',
    'renderer_generator_write_failed', 'renderer_generator_write_timeout',
    'renderer_generator_settings_failed', 'renderer_generator_settings_timeout',
    'renderer_processor_create_failed', 'renderer_processor_read_failed',
    'renderer_processor_read_timeout', 'renderer_processor_ended_without_frame',
    'renderer_callback_timeout', 'renderer_probe_failed',
    'renderer_nv12_allocation_failed', 'renderer_nv12_buffer_limit', 'renderer_nv12_copy_failed',
    'renderer_nv12_copy_timeout', 'renderer_nv12_layout_invalid', 'renderer_cpu_frame_construct_failed',
    'renderer_nv12_marker_mismatch',
  ]);
  const knownErrorNames = new Set(['NotSupportedError', 'InvalidStateError', 'TypeError', 'RangeError',
    'SecurityError', 'OperationError', 'AbortError', 'UnknownError', 'CoveNv12ProbeFailure']);
  function safeErrorName(error) {
    try { const name = error?.name; return knownErrorNames.has(name) ? name : 'OtherError'; }
    catch { return 'OtherError'; }
  }
  function failure(code) {
    const error = new Error(code);
    error.name = 'CoveNv12ProbeFailure';
    return error;
  }
  function requireCondition(condition, code) { if (!condition) throw failure(code); }
  function remaining(run, milliseconds) {
    requireCondition(!run.cancelled && !closed, 'renderer_probe_cancelled');
    const budget = Math.min(milliseconds, run.deadline - performance.now());
    requireCondition(budget > 0, 'renderer_callback_timeout');
    return budget;
  }
  function bounded(promise, milliseconds, code) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure(code)), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
  }
  function colorInfo(frame) {
    const color = frame.colorSpace;
    return {
      primaries: color?.primaries ?? null,
      transfer: color?.transfer ?? null,
      matrix: color?.matrix ?? null,
      fullRange: color?.fullRange ?? null,
    };
  }
  function inspectFrame(frame) {
    requireCondition(frame && typeof frame.copyTo === 'function' && typeof frame.allocationSize === 'function' &&
      typeof frame.clone === 'function', 'renderer_frame_api_invalid');
    requireCondition(frame.format === 'NV12' && frame.codedWidth === 64 && frame.codedHeight === 64 &&
      frame.displayWidth === 64 && frame.displayHeight === 64, 'renderer_frame_metadata_mismatch');
    const color = colorInfo(frame);
    requireCondition(color.primaries === 'bt709' && color.transfer === 'bt709' && color.matrix === 'bt709' &&
      color.fullRange === false, 'renderer_frame_color_space_mismatch');
    return { format: frame.format, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, colorSpace: color };
  }
  // Fixed flat 2x2 regions in the owned synthetic helper image. Only error
  // magnitudes and counts are returned, never copied sample values.
  const markers = [
    [8, 8, 255, 0, 0], [56, 8, 0, 255, 0],
    [8, 62, 0, 0, 255], [56, 62, 255, 255, 255],
    [36, 48, 0, 0, 0], [12, 32, 32, 32, 32],
    [36, 32, 128, 128, 128], [52, 32, 192, 192, 192],
  ];
  const markerNames = ['red', 'green', 'blue', 'white', 'black', 'gray32', 'gray128', 'gray192'];
  function checkRawNv12(buffer, layout) {
    const bytes = new Uint8Array(buffer);
    const zeroCounts = { y: 0, u: 0, v: 0, uv: 0 };
    for (let row = 0; row < 64; ++row) for (let column = 0; column < 64; ++column)
      if (bytes[layout[0].offset + row * layout[0].stride + column] === 0) zeroCounts.y++;
    for (let row = 0; row < 32; ++row) for (let column = 0; column < 64; ++column) {
      if (bytes[layout[1].offset + row * layout[1].stride + column] === 0) {
        zeroCounts.uv++;
        if (column % 2) zeroCounts.v++; else zeroCounts.u++;
      }
    }
    const quantize = value => Math.floor(Math.max(0, Math.min(255, value)) + .5);
    const markerErrors = markers.map((marker, index) => {
      const red = marker[2] / 255, green = marker[3] / 255, blue = marker[4] / 255;
      const luma = .2126 * red + .7152 * green + .0722 * blue;
      const expectedY = quantize(16 + 219 * luma);
      const expectedU = quantize(128 + 224 * (blue - luma) / (2 * (1 - .0722)));
      const expectedV = quantize(128 + 224 * (red - luma) / (2 * (1 - .2126)));
      let yMaximumError = 0;
      for (let y = 0; y < 2; ++y) for (let x = 0; x < 2; ++x) {
        const offset = layout[0].offset + (marker[1] + y) * layout[0].stride + marker[0] + x;
        yMaximumError = Math.max(yMaximumError, Math.abs(bytes[offset] - expectedY));
      }
      const uvOffset = layout[1].offset + marker[1] / 2 * layout[1].stride + marker[0];
      const uError = Math.abs(bytes[uvOffset] - expectedU);
      const vError = Math.abs(bytes[uvOffset + 1] - expectedV);
      return { marker: markerNames[index], yMaximumError, uError, vError,
        passed: Math.max(yMaximumError, uError, vError) <= 1 };
    });
    return { markers: markers.length, yMarkerSamples: markers.length * 4,
      uMarkerSamples: markers.length, vMarkerSamples: markers.length,
      planeSamples: { y: 4096, u: 1024, v: 1024, uv: 2048 }, zeroCounts,
      yMaximumError: Math.max(...markerErrors.map(marker => marker.yMaximumError)),
      uMaximumError: Math.max(...markerErrors.map(marker => marker.uError)),
      vMaximumError: Math.max(...markerErrors.map(marker => marker.vError)),
      markerErrors, tolerance: 1, passed: markerErrors.every(marker => marker.passed) };
  }
  async function makeCpuFrame(frame, run) {
    const bufferByteLimit = 64 * 64 * 4;
    // Keep the failed explicit-format control intact. Chromium's copyTo()
    // rejects explicit non-RGB formats; an omitted format selects the actual
    // VideoFrame format and follows its native plane-readback path instead.
    const copyOptions = useNativeCopyFormat ? {} : { format: 'NV12' };
    const copyStarted = performance.now();
    const measurement = { bufferByteLimit, copiedFormat: frame.format,
      nativeCopyFormat: useNativeCopyFormat, copyOptionFormat: useNativeCopyFormat ? null : 'NV12',
      copyPromiseDeadlineMs: 350, copyCompleted: false, allocationErrorName: null, copyErrorName: null };
    state.result.cpuFrame = measurement;
    let allocationBytes;
    try { allocationBytes = frame.allocationSize(copyOptions); }
    catch (error) {
      measurement.allocationErrorName = safeErrorName(error);
      throw failure('renderer_nv12_allocation_failed');
    }
    measurement.allocationWallMs = performance.now() - copyStarted;
    measurement.allocationBytes = allocationBytes;
    requireCondition(Number.isSafeInteger(allocationBytes) && allocationBytes >= 64 * 64 * 3 / 2 &&
      allocationBytes <= bufferByteLimit, 'renderer_nv12_buffer_limit');
    const buffer = new ArrayBuffer(allocationBytes);
    run.cpuBuffer = buffer;
    let layout;
    const copyCallStarted = performance.now();
    try {
      const copying = Promise.resolve(frame.copyTo(buffer, copyOptions));
      measurement.copyCallWallMs = performance.now() - copyCallStarted;
      // A JS timeout cannot cancel an underlying copy. Erase the small owned
      // buffer if the actual copy eventually settles after this run retires.
      const clearAfterCancellation = () => {
        if (run.cancelled && buffer.byteLength) new Uint8Array(buffer).fill(0);
      };
      copying.then(clearAfterCancellation, clearAfterCancellation);
      layout = await bounded(copying, remaining(run, 350), 'renderer_nv12_copy_timeout');
    } catch (error) {
      measurement.copyCallWallMs ??= performance.now() - copyCallStarted;
      measurement.copyErrorName = safeErrorName(error);
      measurement.gpuToCpuWallMs = performance.now() - copyStarted;
      if (error?.name === 'CoveNv12ProbeFailure') throw error;
      throw failure('renderer_nv12_copy_failed');
    }
    const gpuToCpuWallMs = performance.now() - copyStarted;
    measurement.gpuToCpuWallMs = gpuToCpuWallMs;
    measurement.copyCompleted = true;
    requireCondition(!run.cancelled && !closed, 'renderer_probe_cancelled');
    measurement.planeCount = Array.isArray(layout) ? layout.length : null;
    requireCondition(Array.isArray(layout) && layout.length === 2, 'renderer_nv12_layout_invalid');
    const ends = [];
    for (let plane = 0; plane < 2; ++plane) {
      const height = plane === 0 ? 64 : 32;
      requireCondition(Number.isSafeInteger(layout[plane].offset) && layout[plane].offset >= 0 &&
        Number.isSafeInteger(layout[plane].stride) && layout[plane].stride >= 64,
      'renderer_nv12_layout_invalid');
      const end = layout[plane].offset + layout[plane].stride * (height - 1) + 64;
      requireCondition(Number.isSafeInteger(end) && end <= allocationBytes, 'renderer_nv12_layout_invalid');
      ends.push(end);
    }
    requireCondition(ends[0] <= layout[1].offset || ends[1] <= layout[0].offset, 'renderer_nv12_layout_invalid');
    measurement.layout = layout.map(plane => ({ offset: plane.offset, stride: plane.stride }));
    measurement.planeBytes = [64 * 64, 64 * 32];
    measurement.rawNv12 = checkRawNv12(buffer, layout);
    const frameInit = { format: 'NV12', codedWidth: 64, codedHeight: 64,
      visibleRect: { x: 0, y: 0, width: 64, height: 64 }, displayWidth: 64, displayHeight: 64,
      timestamp: frame.timestamp, layout,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
    const constructStarted = performance.now();
    let transferOptionRejected = false;
    let transferErrorName = null;
    try { run.cpuFrame = new VideoFrame(buffer, { ...frameInit, transfer: [buffer] }); }
    catch (error) {
      // Older implementations may reject transfer. A non-detached buffer can
      // still use the normal copying constructor, preserving NV12/709 planes.
      transferOptionRejected = true;
      transferErrorName = safeErrorName(error);
      requireCondition(buffer.byteLength === allocationBytes, 'renderer_cpu_frame_construct_failed');
      try { run.cpuFrame = new VideoFrame(buffer, frameInit); }
      catch { throw failure('renderer_cpu_frame_construct_failed'); }
    }
    const cpuConstructWallMs = performance.now() - constructStarted;
    const constructTransferDetached = buffer.byteLength === 0;
    const actualFrame = inspectFrame(run.cpuFrame);
    run.gpuFrame?.close(); run.gpuFrame = null;
    return Object.assign(measurement, { allocationBytes, bufferByteLimit, copiedFormat: 'NV12',
      layout: layout.map(plane => ({ offset: plane.offset, stride: plane.stride })),
      gpuToCpuWallMs, copyPromiseDeadlineMs: 350, cpuConstructWallMs,
      transferAttempted: true, transferOptionRejected, transferErrorName, constructTransferDetached,
      bufferBytesAfterConstruct: buffer.byteLength,
      constructionMode: constructTransferDetached ? 'detached-array-buffer' : 'ordinary-buffer-copy',
      actualFrame, originalGpuFrameClosedAfterCopy: true });
  }
  async function checkMarkers(frame, run) {
    const markerErrors = await Promise.all(markers.map(async (marker, index) => {
      const options = { format: 'RGBA', colorSpace: 'srgb',
        rect: { x: marker[0], y: marker[1], width: 2, height: 2 } };
      let bytes, retired = false;
      try {
        const allocation = frame.allocationSize(options);
        requireCondition(Number.isSafeInteger(allocation) && allocation >= 16 && allocation <= 1024,
          'renderer_rgb_layout_invalid');
        bytes = new Uint8Array(allocation);
        const copying = Promise.resolve(frame.copyTo(bytes, options));
        const clearAfterRetirement = () => { if (retired || run.cancelled || closed) bytes.fill(0); };
        copying.then(clearAfterRetirement, clearAfterRetirement);
        const layout = await bounded(copying, remaining(run, 250), 'renderer_rgb_copy_timeout');
        requireCondition(!run.cancelled && !closed, 'renderer_probe_cancelled');
        requireCondition(Array.isArray(layout) && layout.length === 1 &&
          Number.isSafeInteger(layout[0].offset) && layout[0].offset >= 0 &&
          Number.isSafeInteger(layout[0].stride) && layout[0].stride >= 8 &&
          layout[0].offset + layout[0].stride + 8 <= bytes.length, 'renderer_rgb_layout_invalid');
        const channelMaximumError = { r: 0, g: 0, b: 0 };
        const channelNames = ['r', 'g', 'b'];
        let alphaMaximumError = 0, alphaMismatchPixels = 0;
        for (let y = 0; y < 2; ++y) for (let x = 0; x < 2; ++x) {
          const offset = layout[0].offset + layout[0].stride * y + x * 4;
          for (let channel = 0; channel < 3; ++channel) {
            const name = channelNames[channel];
            channelMaximumError[name] = Math.max(channelMaximumError[name], Math.abs(bytes[offset + channel] - marker[2 + channel]));
          }
          alphaMaximumError = Math.max(alphaMaximumError, Math.abs(bytes[offset + 3] - 255));
          if (bytes[offset + 3] !== 255) alphaMismatchPixels++;
        }
        const maximumError = Math.max(...Object.values(channelMaximumError));
        return { marker: markerNames[index], maximumError, channelMaximumError, alphaMaximumError,
          alphaMismatchPixels, passed: maximumError <= 4 && alphaMismatchPixels === 0 };
      } catch (error) {
        return { marker: markerNames[index], passed: false, errorName: safeErrorName(error),
          errorCode: error?.name === 'CoveNv12ProbeFailure' && knownCodes.has(error.message)
            ? error.message : 'renderer_rgb_copy_failed' };
      } finally {
        retired = true;
        bytes?.fill(0);
      }
    }));
    const measuredErrors = markerErrors.filter(marker => Number.isFinite(marker.maximumError));
    const maximumError = measuredErrors.length ? Math.max(...measuredErrors.map(marker => marker.maximumError)) : null;
    return { markers: markers.length, pixels: markers.length * 4, rgbChannels: markers.length * 12,
      maximumError, markerErrors, tolerance: 4, passed: markerErrors.every(marker => marker.passed),
      errorCode: markerErrors.find(marker => marker.errorCode)?.errorCode ?? null };
  }
  function settingsInfo(track) {
    const settings = track.getSettings();
    const safe = {};
    for (const key of ['width', 'height', 'frameRate', 'aspectRatio'])
      if (Number.isFinite(settings[key])) safe[key] = settings[key];
    return safe;
  }
  async function settledSettings(track, run) {
    const deadline = performance.now() + remaining(run, 300);
    do {
      let settings;
      try { settings = settingsInfo(track); }
      catch { throw failure('renderer_generator_settings_failed'); }
      if (settings.width === 64 && settings.height === 64) return settings;
      await new Promise(resolve => setTimeout(resolve, 5));
      requireCondition(!run.cancelled && !closed, 'renderer_probe_cancelled');
    } while (performance.now() < deadline);
    throw failure('renderer_generator_settings_timeout');
  }
  async function dispose(run) {
    if (!run || run.disposed) return;
    run.disposed = true;
    run.cancelled = true;
    // Stop the source before cancelling streams so pending reads/writes wake up.
    try { run.track?.stop(); } catch {}
    try { run.processedFrame?.close(); } catch {}
    run.processedFrame = null;
    try { run.writeFrame?.close(); } catch {}
    run.writeFrame = null;
    try { run.cpuFrame?.close(); } catch {}
    run.cpuFrame = null;
    try { run.gpuFrame?.close(); } catch {}
    run.gpuFrame = null;
    if (run.cpuBuffer?.byteLength) new Uint8Array(run.cpuBuffer).fill(0);
    run.cpuBuffer = null;
    const tasks = [];
    try { if (run.reader) tasks.push(Promise.resolve(run.reader.cancel()).catch(() => {})); } catch {}
    try { if (run.writer) tasks.push(Promise.resolve(run.writer.abort()).catch(() => {})); } catch {}
    if (tasks.length) {
      try { await bounded(Promise.allSettled(tasks), 70, 'renderer_probe_cancelled'); } catch {}
    }
    try { run.reader?.releaseLock(); } catch {}
    try { run.writer?.releaseLock(); } catch {}
    run.reader = null;
    run.writer = null;
    run.processor = null;
    run.track = null;
  }
  window.__coveNv12ProbeCleanup = async () => {
    closed = true;
    try { unsubscribe?.(); } catch {}
    unsubscribe = null;
    await dispose(active);
    if (state.status !== 'complete') {
      state.errorCode ||= 'renderer_probe_cancelled';
      state.status = 'failed';
    }
  };
  if (!supported) {
    state.status = 'failed';
    state.errorCode = generatorAvailable ? 'renderer_native_bridge_unavailable' : 'renderer_generator_unavailable';
    return { supported, processorAvailable, generatorAvailable, cpuFrame: useCpuFrame,
      cpuFrameNativeFormat: useNativeCopyFormat };
  }
  unsubscribe = bridge.onFrame(requestId, async (frame, metadata) => {
    if (closed || state.status !== 'waiting') {
      state.status = 'failed'; state.errorCode = 'renderer_duplicate_frame'; return;
    }
    const run = { cancelled: false, disposed: false, deadline: performance.now() + 1150,
      track: null, writer: null, reader: null, processor: null, processedFrame: null, writeFrame: null,
      cpuFrame: null, cpuBuffer: null, gpuFrame: useCpuFrame ? frame : null };
    active = run;
    state.status = 'running';
    state.result = { deliveryMode: useNativeCopyFormat ? 'native-format-nv12-cpu-frame'
      : useCpuFrame ? 'explicit-nv12-cpu-frame' : 'direct-shared-nv12',
      input: null, cpuFrame: null, rgb: null, generator: null, processor: { available: processorAvailable } };
    let passed = false;
    let currentFailure = 'renderer_probe_failed';
    try {
      requireCondition(metadata && metadata.requestId === requestId && metadata.width === 64 && metadata.height === 64 &&
        metadata.slot === 0 && metadata.serial === 1, 'renderer_frame_metadata_mismatch');
      state.result.input = inspectFrame(frame);
      if (useCpuFrame) {
        currentFailure = 'renderer_nv12_copy_failed';
        state.result.cpuFrame = await makeCpuFrame(frame, run);
      }
      const outputFrame = useCpuFrame ? run.cpuFrame : frame;
      state.result.rgb = await checkMarkers(outputFrame, run);
      requireCondition(state.result.rgb.passed, state.result.rgb.errorCode ?? 'renderer_rgb_marker_mismatch');
      if (useCpuFrame) requireCondition(state.result.cpuFrame.rawNv12.passed, 'renderer_nv12_marker_mismatch');
      currentFailure = 'renderer_generator_create_failed';
      run.track = new MediaStreamTrackGenerator({ kind: 'video' });
      requireCondition(run.track.kind === 'video' && run.track.readyState === 'live' && run.track.writable &&
        typeof run.track.getSettings === 'function', 'renderer_generator_api_invalid');
      run.track.contentHint = 'detail';
      run.writer = run.track.writable.getWriter();
      let read;
      if (processorAvailable) {
        currentFailure = 'renderer_processor_create_failed';
        run.processor = new MediaStreamTrackProcessor({ track: run.track });
        run.reader = run.processor.readable.getReader();
        // Retain no unclaimed frame if a late read completes after cancellation.
        read = run.reader.read().then(packet => {
          if (run.cancelled || closed) {
            try { packet.value?.close(); } catch {}
            throw failure('renderer_probe_cancelled');
          }
          // The read can resolve before settings settle. Own its frame now so
          // write/settings failure cleanup closes it even before the await.
          run.processedFrame = packet.value || null;
          return packet;
        });
        // Rejections are consumed immediately; the awaited read below still
        // reports the fixed failure to the result.
        read.catch(() => {});
      }
      run.writeFrame = outputFrame.clone();
      currentFailure = 'renderer_generator_write_failed';
      const writeStarted = performance.now();
      await bounded(run.writer.write(run.writeFrame), remaining(run, 350), 'renderer_generator_write_timeout');
      const writeWallMs = performance.now() - writeStarted;
      currentFailure = 'renderer_generator_settings_failed';
      const settings = await settledSettings(run.track, run);
      state.result.generator = { wroteFrame: true, writeWallMs, settings,
        readyStateBeforeStop: run.track.readyState, contentHint: run.track.contentHint };
      if (processorAvailable) {
        currentFailure = 'renderer_processor_read_failed';
        const packet = await bounded(read, remaining(run, 500), 'renderer_processor_read_timeout');
        requireCondition(packet && !packet.done && packet.value, 'renderer_processor_ended_without_frame');
        run.processedFrame = packet.value;
        state.result.processor = { available: true, readFrame: true,
          frame: inspectFrame(run.processedFrame), rgb: await checkMarkers(run.processedFrame, run) };
        requireCondition(state.result.processor.rgb.passed,
          state.result.processor.rgb.errorCode ?? 'renderer_rgb_marker_mismatch');
        run.processedFrame.close(); run.processedFrame = null;
      }
      passed = true;
    } catch (error) {
      state.errorCode = error?.name === 'CoveNv12ProbeFailure' && knownCodes.has(error.message)
        ? error.message : currentFailure;
    } finally {
      await dispose(run);
      active = null;
      try { unsubscribe?.(); } catch {}
      unsubscribe = null;
      if (closed && passed) { passed = false; state.errorCode = 'renderer_probe_cancelled'; }
      state.result.passed = passed;
      state.result.resourcesDisposed = run.disposed && !run.track && !run.reader && !run.writer && !run.writeFrame &&
        !run.processedFrame && !run.cpuFrame && !run.gpuFrame && !run.cpuBuffer;
      state.status = passed ? 'complete' : 'failed';
      // The real preload owns the callback's input frame and its import release.
    }
  });
  return { supported, processorAvailable, generatorAvailable, cpuFrame: useCpuFrame,
    cpuFrameNativeFormat: useNativeCopyFormat };
};
