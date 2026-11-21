import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  findNodeHandle,
  Modal,
  NativeModules,
  Platform,
  StatusBar,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Volume2, X } from 'lucide-react-native';
import { ZoomableScreenVideo } from '../../media/screen/components/ZoomableScreenVideo';
import { useCoveTheme } from '../../settings/ThemeProvider';
import { useRoomStyles } from './roomStyles';

const CONTROLS_IDLE_MS = 3000;

type ViewerBridge = {
  setScreenViewerOrientation?(enabled: boolean): void;
  setScreenViewerImmersive?(modalTag: number, enabled: boolean): void;
};
const viewerBridge = (): ViewerBridge | undefined =>
  Platform.OS === 'android' ? NativeModules.CoveScreenViewer : undefined;

export function FullscreenScreenViewer({
  streamURL,
  volumeControls,
  onClose,
}: {
  streamURL: string;
  volumeControls: ReactNode;
  onClose: () => void;
}) {
  const styles = useRoomStyles();
  const { colors } = useCoveTheme();
  const modal = useRef<Modal>(null);
  const modalTag = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);

  const stopIdle = useCallback(() => {
    clearTimeout(idle.current);
  }, []);
  const scheduleIdle = useCallback(() => {
    stopIdle();
    idle.current = setTimeout(() => {
      setControlsVisible(false);
      setVolumeOpen(false);
      setImmersive(true);
    }, CONTROLS_IDLE_MS);
  }, [stopIdle]);

  useEffect(() => {
    const bridge = viewerBridge();
    bridge?.setScreenViewerOrientation?.(true);
    scheduleIdle();
    return () => {
      stopIdle();
      bridge?.setScreenViewerImmersive?.(modalTag.current, false);
      bridge?.setScreenViewerOrientation?.(false);
    };
  }, [scheduleIdle, stopIdle]);

  useEffect(() => {
    if (immersive)
      viewerBridge()?.setScreenViewerImmersive?.(modalTag.current, true);
  }, [immersive]);

  const revealControls = () => {
    setControlsVisible(true);
    scheduleIdle();
  };

  return (
    <Modal
      ref={modal}
      visible
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      supportedOrientations={['portrait', 'landscape']}
      onShow={event => {
        const bridge = viewerBridge();
        if (!bridge) return;
        modalTag.current =
          findNodeHandle(modal.current) ?? event?.nativeEvent?.target ?? 0;
        if (immersive)
          bridge.setScreenViewerImmersive?.(modalTag.current, true);
      }}
      onRequestClose={onClose}
    >
      <View
        style={styles.fullscreen}
        onTouchStart={controlsVisible ? stopIdle : undefined}
        onTouchEnd={
          controlsVisible
            ? event => {
                if (event.nativeEvent.touches.length === 0) scheduleIdle();
              }
            : undefined
        }
        onTouchCancel={controlsVisible ? scheduleIdle : undefined}
      >
        {Platform.OS !== 'android' && <StatusBar hidden={immersive} />}
        <ZoomableScreenVideo
          key={streamURL}
          streamURL={streamURL}
          onTap={revealControls}
          showZoomControl={controlsVisible}
        />
        {controlsVisible && (
          <>
            {volumeOpen && (
              <SafeAreaView
                style={styles.fullscreenVolume}
                edges={['bottom', 'left', 'right']}
              >
                {volumeControls}
              </SafeAreaView>
            )}
            <SafeAreaView
              style={styles.fullscreenSafe}
              edges={['top', 'right']}
            >
              <TouchableOpacity
                style={styles.closeFullscreen}
                accessibilityRole="button"
                accessibilityLabel="关闭全屏共享"
                onPress={onClose}
              >
                <X size={22} color={colors.onVideo} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.closeFullscreen, styles.fullscreenVolumeButton]}
                accessibilityRole="button"
                accessibilityLabel="全屏共享音量"
                onPress={() => {
                  setVolumeOpen(value => !value);
                  scheduleIdle();
                }}
              >
                <Volume2 size={22} color={colors.onVideo} />
              </TouchableOpacity>
            </SafeAreaView>
          </>
        )}
      </View>
    </Modal>
  );
}
