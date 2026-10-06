import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter, Keyboard, NativeModules, Platform, type EmitterSubscription, type KeyboardMetrics, type ScrollView, type TextInput } from 'react-native';
import { computeKeyboardScroll, useKeyboardInset, type KeyboardInset } from '../src/features/keyboard/useKeyboardInset';

test('leaves an already visible input in place', () => {
  expect(computeKeyboardScroll(360, 40, 40, 760, 500, 18)).toBe(0);
});

test('moves an obscured input just above the real keyboard top', () => {
  expect(computeKeyboardScroll(480, 40, 40, 760, 500, 18)).toBe(38);
});

test('does not subtract the keyboard twice from an already resized viewport', () => {
  expect(computeKeyboardScroll(420, 40, 40, 460, 500, 18)).toBe(0);
  expect(computeKeyboardScroll(460, 40, 40, 460, 500, 18)).toBe(18);
});

test('reveals a higher input after scrolling to a lower input', () => {
  expect(computeKeyboardScroll(10, 40, 40, 760, 500, 18)).toBe(-48);
});

describe('focused input lifecycle', () => {
  let inset: KeyboardInset;
  let renderer: TestRenderer.ReactTestRenderer;
  let listeners: Map<string, (event: { endCoordinates: KeyboardMetrics }) => void>;
  let viewportHeight: number;
  let inputY: number;
  let actualScrollY: number;
  let maxScrollY: number;
  let scrollTo: jest.Mock;
  let input: TextInput;
  let viewportMeasure: jest.Mock;
  const metrics = (screenY = 500, height = 300): KeyboardMetrics => ({ screenY, height, screenX: 0, width: 400 });
  const layoutEvent = { nativeEvent: { layout: { x: 0, y: 40, width: 400, height: 460 } } };

  beforeEach(async () => {
    jest.useFakeTimers();
    Platform.OS = 'android';
    NativeModules.CoveKeyboard = undefined;
    listeners = new Map();
    jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
      listeners.set(name, event => listener({ duration: 0, easing: 'keyboard', ...event }));
      return { remove: jest.fn(() => listeners.delete(name)) } as unknown as EmitterSubscription;
    });
    viewportHeight = 760;
    inputY = 680;
    actualScrollY = 0;
    maxScrollY = 1000;
    viewportMeasure = jest.fn(callback => callback(0, 40, 400, viewportHeight));
    input = { measureInWindow: jest.fn(callback => callback(0, inputY - actualScrollY, 200, 40)) } as unknown as TextInput;
    scrollTo = jest.fn(({ y }) => {
      actualScrollY = Math.min(maxScrollY, y);
      inset.onScroll({ nativeEvent: { contentOffset: { x: 0, y: actualScrollY } } } as never);
    });
    function Harness() { inset = useKeyboardInset(18); return null; }
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
    inset!.scrollView.current = {
      getNativeScrollRef: () => ({ measureInWindow: viewportMeasure }), scrollTo,
    } as unknown as ScrollView;
  });

  afterEach(async () => {
    await act(async () => renderer.unmount());
    jest.runOnlyPendingTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
    NativeModules.CoveKeyboard = undefined;
  });

  async function flush() { await act(async () => { jest.runOnlyPendingTimers(); }); }
  async function show(screenY = 500, height = 300) {
    await act(async () => listeners.get('keyboardDidShow')!({ endCoordinates: metrics(screenY, height) }));
    await flush();
  }

  async function mountNative(getKeyboardFrame = jest.fn(async () => null)) {
    await act(async () => renderer.unmount());
    NativeModules.CoveKeyboard = { getKeyboardFrame, addListener: jest.fn(), removeListeners: jest.fn() };
    function NativeHarness() { inset = useKeyboardInset(18); return null; }
    await act(async () => { renderer = TestRenderer.create(React.createElement(NativeHarness)); });
    inset.scrollView.current = { getNativeScrollRef: () => ({ measureInWindow: viewportMeasure }), scrollTo } as unknown as ScrollView;
  }

  async function nativeFrame(top: number, height = 300, visible = true) {
    await act(async () => DeviceEventEmitter.emit('coveKeyboardFrame', { top, height, visible, width: 400 }));
    await flush();
  }

  test('waits for the keyboard when focus happens first', async () => {
    inset.bindInput(input);
    await flush();
    expect(scrollTo).not.toHaveBeenCalled();
    await show();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 238, animated: false });
    expect(inset.bottomInset).toBe(300);
  });

  test('uses the new viewport after adjustResize, without double padding', async () => {
    viewportHeight = 460;
    inputY = 460;
    inset.bindInput(input);
    await show();
    expect(inset.bottomInset).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 18, animated: false });
  });

  test('retries after padding layout and uses the actual clamped scroll offset', async () => {
    maxScrollY = 0;
    inset.bindInput(input);
    await show();
    expect(actualScrollY).toBe(0);
    maxScrollY = 1000;
    inset.onContentSizeChange(400, 1500);
    await flush();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 238, animated: false });
    expect(actualScrollY).toBe(238);
  });

  test('retries when native layout arrives after the keyboard event', async () => {
    viewportHeight = 0;
    inset.bindInput(input);
    await show();
    expect(scrollTo).not.toHaveBeenCalled();
    viewportHeight = 460;
    inset.onLayout(layoutEvent as never);
    await flush();
    expect(actualScrollY).toBe(238);
  });

  test('corrects focus changes while the keyboard is already open', async () => {
    inset.bindInput(input);
    await show();
    expect(actualScrollY).toBe(238);
    inputY = 260;
    inset.bindInput({ measureInWindow: (callback: any) => callback(0, inputY - actualScrollY, 200, 40) } as TextInput);
    await flush();
    expect(actualScrollY).toBe(202);
  });

  test('ignores a delayed blur from the previously focused input', async () => {
    inset.bindInput(input);
    await show();
    inputY = 260;
    const higherInput = { measureInWindow: (callback: any) => callback(0, inputY - actualScrollY, 200, 40) } as TextInput;
    inset.bindInput(higherInput);
    inset.unbindInput(input);
    await flush();
    expect(actualScrollY).toBe(202);
  });

  test('re-aligns after Android overwrites the first focus scroll', async () => {
    inset.bindInput(input);
    await show();
    actualScrollY = 100;
    inset.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 100 } } } as never);
    await act(async () => jest.advanceTimersByTime(400));
    expect(actualScrollY).toBe(238);
  });

  test('native normalized insets work without any React Native keyboard event', async () => {
    await mountNative();
    inset.bindInput(input);
    await nativeFrame(450);
    expect(actualScrollY).toBe(288);
    expect(inset.keyboardHeight).toBe(300);
    await show(500);
    expect(actualScrollY).toBe(288);
  });

  test('native toolbar changes correct the same-height keyboard while it stays visible', async () => {
    await mountNative();
    inset.bindInput(input);
    await nativeFrame(450);
    await nativeFrame(400);
    expect(actualScrollY).toBe(338);
  });

  test('ignores a stale native snapshot arriving after a newer frame event', async () => {
    let resolveSnapshot!: (frame: any) => void;
    await mountNative(jest.fn(() => new Promise(resolve => { resolveSnapshot = resolve; })) as never);
    inset.bindInput(input);
    await nativeFrame(450);
    await act(async () => resolveSnapshot({ visible: false, top: 0, height: 0, width: 400 }));
    expect(inset.keyboardHeight).toBe(300);
  });

  test('native hide clears insets and stops delayed corrections', async () => {
    await mountNative();
    inset.bindInput(input);
    await nativeFrame(450);
    scrollTo.mockClear();
    await nativeFrame(0, 0, false);
    await act(async () => jest.advanceTimersByTime(400));
    expect(inset.keyboardHeight).toBe(0);
    expect(inset.bottomInset).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('native observer subscription is removed on unmount', async () => {
    await mountNative();
    expect(NativeModules.CoveKeyboard.addListener).toHaveBeenCalledWith('coveKeyboardFrame');
    await act(async () => renderer.unmount());
    expect(NativeModules.CoveKeyboard.removeListeners).toHaveBeenCalledWith(1);
  });

  test('handles a keyboard frame change even when height stays the same', async () => {
    inset.bindInput(input);
    await show();
    await act(async () => listeners.get('keyboardDidChangeFrame')!({ endCoordinates: metrics(450) }));
    await flush();
    expect(actualScrollY).toBe(288);
    expect(inset.bottomInset).toBe(350);
  });

  test('ignores measurements from a previously focused input', async () => {
    let deferredMeasure: ((x: number, y: number, width: number, height: number) => void) | undefined;
    inset.bindInput({ measureInWindow: (callback: typeof deferredMeasure) => { deferredMeasure = callback; } } as TextInput);
    await show();
    inset.bindInput(input);
    deferredMeasure!(0, 1000, 200, 40);
    expect(scrollTo).not.toHaveBeenCalled();
    await flush();
    expect(actualScrollY).toBe(238);
  });

  test('cancels scrolling on blur and keyboard dismissal', async () => {
    inset.bindInput(input);
    await show();
    scrollTo.mockClear();
    inset.scrollFocusedAboveKeyboard();
    inset.bindInput(null);
    await flush();
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => listeners.get('keyboardDidHide')!({ endCoordinates: metrics(800, 0) }));
    expect(inset.keyboardHeight).toBe(0);
    expect(inset.bottomInset).toBe(0);
  });

  test('cancels queued work on unmount', async () => {
    inset.bindInput(input);
    await act(async () => listeners.get('keyboardDidShow')!({ endCoordinates: metrics() }));
    await act(async () => renderer.unmount());
    await flush();
    expect(viewportMeasure).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
