import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  NativeEventEmitter,
  NativeModules,
  Platform,
  type KeyboardMetrics,
  type LayoutChangeEvent,
  type EmitterSubscription,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type TextInput,
} from 'react-native';

export interface KeyboardInset {
  /** Keyboard height in dp; 0 when hidden. */
  keyboardHeight: number;
  /** Only the part of the ScrollView covered by the keyboard (not a resized window). */
  bottomInset: number;
  scrollView: React.RefObject<ScrollView | null>;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
  /** Track the focused TextInput and lift it above the keyboard. */
  bindInput: (input: TextInput | null) => void;
  unbindInput: (input: TextInput | null) => void;
  /** Scroll the focused input so it sits just above the keyboard. */
  scrollFocusedAboveKeyboard: (gap?: number) => void;
}

/** Signed scroll correction in screen coordinates; also reveals fields above the viewport. */
export function computeKeyboardScroll(
  inputWindowY: number,
  inputHeight: number,
  viewportY: number,
  viewportHeight: number,
  keyboardTop: number,
  gap: number,
): number {
  const visibleBottom = Math.min(viewportY + viewportHeight, keyboardTop);
  const bottomOverlap = inputWindowY + inputHeight + gap - visibleBottom;
  if (bottomOverlap > 0) return bottomOverlap;
  return Math.min(0, inputWindowY - viewportY - gap);
}

/**
 * Tracks the software keyboard and keeps the focused TextInput visible above it.
 *
 * Android uses native IME insets normalized to Fabric measurement coordinates.
 * React Native keyboard events remain a fallback and the iOS implementation.
 */
export function useKeyboardInset(defaultGap = 16): KeyboardInset {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [bottomInset, setBottomInset] = useState(0);
  const focusedInput = useRef<TextInput | null>(null);
  const scrollView = useRef<ScrollView | null>(null);
  const scrollYRef = useRef(0);
  const keyboardRef = useRef<KeyboardMetrics | null>(null);
  const pendingFrame = useRef<number | null>(null);
  const settleTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const generation = useRef(0);
  const defaultGapRef = useRef(defaultGap);
  defaultGapRef.current = defaultGap;

  const cancelPendingScroll = useCallback(() => {
    generation.current += 1;
    if (pendingFrame.current !== null)
      cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
  }, []);

  const cancelSettling = useCallback(() => {
    settleTimers.current.forEach(clearTimeout);
    settleTimers.current = [];
  }, []);

  const scrollFocusedAboveKeyboard = useCallback(
    (gap?: number) => {
      cancelPendingScroll();
      if (!focusedInput.current || !scrollView.current || !keyboardRef.current)
        return;
      const pad = gap ?? defaultGapRef.current;
      const currentGeneration = generation.current;
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = null;
        const input = focusedInput.current;
        const scroller = scrollView.current;
        const metrics = keyboardRef.current;
        if (!input || !scroller || !metrics) return;
        const isCurrent = () =>
          generation.current === currentGeneration &&
          focusedInput.current === input &&
          scrollView.current === scroller &&
          keyboardRef.current === metrics;
        // Native Android frame.top is normalized to measureInWindow's origin.
        // adjustResize may already have shortened the viewport: don't subtract
        // keyboard height from that shortened window a second time.
        const keyboardTop = Number.isFinite(metrics.screenY)
          ? metrics.screenY
          : Dimensions.get('screen').height - metrics.height;
        scroller
          .getNativeScrollRef()
          ?.measureInWindow((_x, viewportY, _width, viewportHeight) => {
            if (!isCurrent() || viewportHeight <= 0) return;
            setBottomInset(
              Math.max(0, viewportY + viewportHeight - keyboardTop),
            );
            input.measureInWindow((_inputX, y, _inputWidth, height) => {
              if (!isCurrent() || height <= 0) return;
              const correction = computeKeyboardScroll(
                y,
                height,
                viewportY,
                viewportHeight,
                keyboardTop,
                pad,
              );
              if (Math.abs(correction) > 1) {
                scroller.scrollTo({
                  y: Math.max(0, scrollYRef.current + correction),
                  animated: false,
                });
                // Only onScroll knows the actual offset: native may clamp this
                // request until the new bottom padding has finished layout.
              }
            });
          });
      });
    },
    [cancelPendingScroll],
  );

  const alignAndSettle = useCallback(() => {
    cancelSettling();
    scrollFocusedAboveKeyboard();
    if (!focusedInput.current || !keyboardRef.current) return;
    // Android may perform its own focus scroll after JS receives the keyboard
    // event. Re-measure after that transition, without an ongoing polling loop.
    settleTimers.current = [120, 320].map(delay =>
      setTimeout(scrollFocusedAboveKeyboard, delay),
    );
  }, [cancelSettling, scrollFocusedAboveKeyboard]);

  useEffect(() => {
    let active = true;
    let nativeFrameReceived = false;
    let nativeRevision = 0;
    const onHide = () => {
      cancelSettling();
      cancelPendingScroll();
      keyboardRef.current = null;
      setKeyboardHeight(0);
      setBottomInset(0);
    };
    const onShow = (event: { endCoordinates: KeyboardMetrics }) => {
      if (event.endCoordinates.height <= 0) return onHide();
      keyboardRef.current = event.endCoordinates;
      setKeyboardHeight(event.endCoordinates.height);
      alignAndSettle();
    };
    const onReactNativeShow = (event: { endCoordinates: KeyboardMetrics }) => {
      if (!nativeFrameReceived) onShow(event);
    };
    const subscriptions: EmitterSubscription[] = [
      Keyboard.addListener('keyboardDidShow', onReactNativeShow),
      Keyboard.addListener('keyboardDidHide', () => {
        if (!nativeFrameReceived) onHide();
      }),
      Keyboard.addListener('keyboardDidChangeFrame', onReactNativeShow),
    ];
    if (Platform.OS === 'ios') {
      subscriptions.push(
        Keyboard.addListener('keyboardWillShow', onShow),
        Keyboard.addListener('keyboardWillHide', onHide),
        Keyboard.addListener('keyboardWillChangeFrame', onShow),
      );
    }
    const metrics = Keyboard.metrics();
    if (metrics?.height) onShow({ endCoordinates: metrics });
    const native =
      Platform.OS === 'android' ? NativeModules.CoveKeyboard : undefined;
    if (native?.getKeyboardFrame) {
      type NativeFrame = {
        visible: boolean;
        top: number;
        height: number;
        width: number;
      };
      const onNativeFrame = (frame: NativeFrame | null) => {
        if (
          !active ||
          !frame ||
          !Number.isFinite(frame.top) ||
          !Number.isFinite(frame.height)
        )
          return;
        nativeFrameReceived = true;
        if (!frame.visible || frame.height <= 0) return onHide();
        onShow({
          endCoordinates: {
            screenY: frame.top,
            height: frame.height,
            screenX: 0,
            width: frame.width,
          },
        });
      };
      subscriptions.push(
        new NativeEventEmitter(native).addListener(
          'coveKeyboardFrame',
          frame => {
            nativeRevision += 1;
            onNativeFrame(frame);
          },
        ),
      );
      const revision = nativeRevision;
      void native
        .getKeyboardFrame()
        .then((frame: NativeFrame | null) => {
          if (nativeRevision === revision) onNativeFrame(frame);
        })
        .catch(() => {
          /* Keep React Native fallback if no native frame is available. */
        });
    }
    return () => {
      active = false;
      cancelSettling();
      cancelPendingScroll();
      subscriptions.forEach(subscription => subscription.remove());
    };
  }, [alignAndSettle, cancelPendingScroll, cancelSettling]);

  // Re-align when the keyboard appears or resizes (emoji / suggestion strip).
  useEffect(() => {
    if (keyboardHeight > 0) scrollFocusedAboveKeyboard();
  }, [keyboardHeight, scrollFocusedAboveKeyboard]);

  const bindInput = useCallback(
    (input: TextInput | null) => {
      focusedInput.current = input;
      alignAndSettle();
    },
    [alignAndSettle],
  );

  const unbindInput = useCallback(
    (input: TextInput | null) => {
      // A delayed blur from the old field must not clear the newly focused field.
      if (focusedInput.current === input) bindInput(null);
    },
    [bindInput],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollYRef.current = event.nativeEvent.contentOffset.y;
    },
    [],
  );

  const onLayoutChange = useCallback(
    () => scrollFocusedAboveKeyboard(),
    [scrollFocusedAboveKeyboard],
  );

  return {
    keyboardHeight,
    bottomInset,
    scrollView,
    onScroll,
    onLayout: onLayoutChange,
    onContentSizeChange: onLayoutChange,
    bindInput,
    unbindInput,
    scrollFocusedAboveKeyboard,
  };
}
