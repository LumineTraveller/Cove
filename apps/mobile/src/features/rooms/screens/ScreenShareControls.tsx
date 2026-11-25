import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScreenShare, X } from 'lucide-react-native';
import type { useMobileScreenShare } from '../../media/screen/useMobileScreenShare';
import { SCREEN_CAPTURE_SCALES } from '../../media/screen/screenCaptureSettings';
import { useScreenSharingPreferences } from '../../media/screen/useScreenSharingPreferences';
import { useCoveTheme } from '../../settings/ThemeProvider';
import { useRoomStyles } from './roomStyles';

export function ScreenShareControls({
  media,
}: {
  media: ReturnType<typeof useMobileScreenShare> & { inVoice: boolean };
}) {
  const { colors } = useCoveTheme();
  const styles = useRoomStyles();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    includeScreenAudio,
    setIncludeScreenAudio,
    screenCaptureScale,
    setScreenCaptureScale,
  } = useScreenSharingPreferences();
  const {
    inVoice,
    sharingScreen,
    sharingScreenAudio,
    screenSharingBusy,
    screenSharingError,
    screenViewerCount,
    canShareScreenAudio,
    clearScreenSharingError,
    startScreenShare,
    stopScreenShare,
  } = media;
  const includeAudio = canShareScreenAudio && includeScreenAudio;
  const canStart = inVoice && !screenSharingBusy && !sharingScreen;
  const closeSettings = () => {
    stopScreenShare();
    setSettingsOpen(false);
  };
  const startSharing = async () => {
    if (await startScreenShare(includeAudio, screenCaptureScale)) {
      setSettingsOpen(false);
    }
  };

  return (
    <>
      <View style={styles.ownScreenCard} testID="own-screen-sharing">
        <View style={styles.ownScreenCopy}>
          <ScreenShare size={20} color={colors.amber} />
          <View style={styles.ownScreenText}>
            <Text style={styles.sectionTitle}>
              {sharingScreen ? '正在共享手机屏幕' : '共享手机屏幕'}
            </Text>
            {sharingScreen ? (
              <Text style={styles.sectionSubtitle}>
                {sharingScreenAudio ? '画面与音频' : '仅画面'} · {screenViewerCount}{' '}
                人观看
              </Text>
            ) : screenSharingBusy ? (
              <Text style={styles.sectionSubtitle}>正在启动共享…</Text>
            ) : null}
          </View>
        </View>
        {sharingScreen || screenSharingBusy ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={sharingScreen ? '停止共享' : '取消启动共享'}
            style={styles.stopShareButton}
            onPress={stopScreenShare}
          >
            <Text style={styles.stopShareText}>
              {sharingScreen ? '停止共享' : '取消'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="共享手机屏幕"
            style={styles.startShareButton}
            onPress={() => {
              clearScreenSharingError();
              setSettingsOpen(true);
            }}
          >
            <Text style={styles.startShareText}>共享</Text>
          </TouchableOpacity>
        )}
      </View>
      {!settingsOpen && screenSharingError && (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {screenSharingError}
        </Text>
      )}

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={closeSettings}
      >
        <SafeAreaView style={styles.toolModal} edges={['top', 'right', 'bottom', 'left']}>
          <View style={styles.toolHeader}>
            <View style={[styles.toolHeaderIcon, styles.toolScreenIcon]}>
              <ScreenShare size={19} color={colors.amber} />
            </View>
            <Text style={[styles.headerCopy, styles.toolTitle]}>共享手机屏幕</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="关闭屏幕共享设置"
              style={styles.iconButton}
              onPress={closeSettings}
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.toolContent}>
            <View style={styles.audioSettingsSection}>
              <Text style={styles.sectionTitle}>画面采集比例</Text>
              <View style={styles.limitPresets}>
                {SCREEN_CAPTURE_SCALES.map(({ value, label }) => {
                  const selected = screenCaptureScale === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      accessibilityRole="radio"
                      accessibilityLabel={`画面采集比例：${label}`}
                      accessibilityState={{
                        checked: selected,
                        disabled: screenSharingBusy,
                      }}
                      disabled={screenSharingBusy}
                      style={[
                        styles.limitPreset,
                        selected && styles.screenScaleActive,
                        screenSharingBusy && styles.screenScaleDisabled,
                      ]}
                      onPress={() => setScreenCaptureScale(value)}
                    >
                      <Text style={styles.limitPresetText}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.screenShareOption}>
              <View style={styles.ownScreenText}>
                <Text style={styles.sectionTitle}>同时共享音频</Text>
                <Text style={styles.sectionSubtitle}>
                  {canShareScreenAudio
                    ? '共享应用播放的声音'
                    : '当前设备不支持共享应用音频'}
                </Text>
              </View>
              <Switch
                accessibilityLabel="同时共享音频"
                value={includeAudio}
                disabled={screenSharingBusy || !canShareScreenAudio}
                onValueChange={setIncludeScreenAudio}
              />
            </View>
            {screenSharingError && (
              <Text style={styles.formError} accessibilityLiveRegion="polite">
                {screenSharingError}
              </Text>
            )}
            {!inVoice && !screenSharingError && (
              <Text style={styles.sectionSubtitle}>加入语音后即可开始共享。</Text>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="开始共享手机屏幕"
              disabled={!canStart}
              style={[
                styles.submit,
                styles.screenSubmit,
                !canStart && styles.controlDisabled,
              ]}
              onPress={startSharing}
            >
              {screenSharingBusy && <ActivityIndicator color={colors.onScreen} />}
              <Text style={[styles.submitText, styles.screenSubmitText]}>
                {screenSharingBusy ? '正在启动共享…' : '开始共享'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
