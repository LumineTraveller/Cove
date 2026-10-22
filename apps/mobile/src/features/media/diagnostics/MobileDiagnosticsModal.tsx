import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CoveButton } from '../../../components/CoveUi';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import { type CoveColors } from '../../settings/theme';
import { saveTextFile } from '../../soundpacks/soundpackFiles';
import {
  normalizeMobileDiagnostics,
  mobileRoundTripTimeMs,
  videoBitrate,
  videoDiagnosticSample,
  videoEncodingPerformance,
  type MobileDiagnosticsInput,
  type MobileDiagnosticReport,
} from './mobileDiagnostics';
export function MobileDiagnostics({
  visible,
  collect,
  onClose,
}: {
  visible: boolean;
  collect: () => Promise<MobileDiagnosticsInput>;
  onClose: () => void;
}) {
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [report, setReport] = useState<MobileDiagnosticReport | null>(null);
  const [bitrate, setBitrate] = useState<number | null>(null);
  const [encodingPerformance, setEncodingPerformance] = useState<
    ReturnType<typeof videoEncodingPerformance>
  >({ framesPerSecond: null, encodeMsPerFrame: null });
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const generation = useRef(0),
    running = useRef(false),
    exporting = useRef(false);
  const previous = useRef<MobileDiagnosticReport | null>(null);
  const collectRef = useRef(collect);
  collectRef.current = collect;
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    const revision = generation.current;
    setBusy(true);
    setError('');
    try {
      const next = normalizeMobileDiagnostics(await collectRef.current());
      if (revision !== generation.current) return;
      setBitrate(videoBitrate(previous.current, next));
      setEncodingPerformance(videoEncodingPerformance(previous.current, next));
      previous.current = next;
      setReport(next);
    } catch (cause) {
      if (revision === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '暂时无法读取媒体状态，请重试。',
        );
    } finally {
      if (revision === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    generation.current += 1;
    running.current = false;
    exporting.current = false;
    previous.current = null;
    setReport(null);
    setBitrate(null);
    setEncodingPerformance({ framesPerSecond: null, encodeMsPerFrame: null });
    setNotice('');
    setError('');
    setSaving(false);
    setBusy(false);
    if (visible) void refreshRef.current();
    return () => {
      generation.current += 1;
    };
  }, [visible]);
  const save = async () => {
    if (!report || exporting.current) return;
    exporting.current = true;
    const revision = generation.current;
    setSaving(true);
    setNotice('');
    try {
      const saved = await saveTextFile(
        JSON.stringify(
          {
            ...report,
            interval: {
              videoBitrateBps: bitrate,
              encodedFramesPerSecond: encodingPerformance.framesPerSecond,
              encodeMsPerFrame: encodingPerformance.encodeMsPerFrame,
            },
          },
          null,
          2,
        ),
        `Cove-media-${new Date(report.sampledAt)
          .toISOString()
          .replace(/[:.]/g, '-')}.json`,
      );
      if (revision === generation.current)
        setNotice(saved ? '媒体状态已保存。' : '已取消保存。');
    } catch (cause) {
      if (revision === generation.current)
        setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    } finally {
      if (revision === generation.current) {
        exporting.current = false;
        setSaving(false);
      }
    }
  };
  const video = report ? videoDiagnosticSample(report) : undefined;
  const sending =
    video?.transport === 'screenSend' || report?.stage.sharing === true;
  const actualFps =
    video?.values.framesPerSecond ??
    encodingPerformance.framesPerSecond ??
    undefined;
  const ready = sending ? report?.screenEncoder?.ready : undefined;
  const display = (value: number | undefined, unit = '') =>
    value === undefined ? '未提供' : `${Math.round(value * 10) / 10}${unit}`;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.overlay}>
        <View style={styles.card}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>媒体状态</Text>
            <Text style={styles.hint}>
              显示设备提供的实际数据。刷新两次可计算码率、发送帧率与每帧编码耗时；未提供的指标保持空缺。
            </Text>
            {busy && <ActivityIndicator color={colors.blue} />}
            {report && (
              <>
                <Text style={styles.hint}>
                  采样于{' '}
                  {new Date(report.sampledAt).toLocaleTimeString('zh-CN')}
                </Text>
                <Text style={styles.hint}>
                  RTT 是手机与 SFU 的往返时间，不是采集到显示的端到端延迟。
                </Text>
                <View style={styles.metrics}>
                  <Text style={styles.metric}>
                    RTT　{display(mobileRoundTripTimeMs(report) ?? undefined, ' ms')}
                  </Text>
                  <Text style={styles.metric}>
                    视频方向　
                    {sending
                      ? '手机屏幕发送'
                      : video
                      ? '手机接收观看'
                      : '暂无视频数据'}
                  </Text>
                  <Text style={styles.metric}>
                    视频帧率　{display(actualFps, ' FPS')}
                  </Text>
                  <Text style={styles.metric}>
                    视频尺寸　
                    {video?.values.frameWidth && video?.values.frameHeight
                      ? `${video.values.frameWidth} × ${video.values.frameHeight}`
                      : '未提供'}
                  </Text>
                  <Text style={styles.metric}>
                    视频编码　{video?.codec ?? '未提供'}
                  </Text>
                  {sending && (
                    <>
                      <Text style={styles.metric}>
                        实际编码器　
                        {video?.encoderImplementation ??
                          ready?.implementation ??
                          '未提供'}
                      </Text>
                      <Text style={styles.metric}>
                        原生硬件加速　
                        {ready
                          ? ready.hardwareAccelerated
                            ? '是（已初始化）'
                            : '否'
                          : '未提供'}
                      </Text>
                      <Text style={styles.metric}>
                        编码器帧率上限　
                        {display(ready?.encoderMaxFramerate, ' FPS')}
                      </Text>
                      <Text style={styles.metric}>
                        省电编码器　
                        {video?.powerEfficientEncoder === undefined
                          ? '未提供'
                          : video.powerEfficientEncoder
                          ? '是（设备统计）'
                          : '否（设备统计）'}
                      </Text>
                      <Text style={styles.metric}>
                        编码耗时　
                        {encodingPerformance.encodeMsPerFrame === null
                          ? '需再次刷新或设备未提供'
                          : `${encodingPerformance.encodeMsPerFrame.toFixed(
                              2,
                            )} ms／帧`}
                      </Text>
                      <Text style={styles.metric}>
                        质量限制原因　
                        {video?.qualityLimitationReason
                          ? {
                              none: '无',
                              cpu: 'CPU',
                              bandwidth: '带宽',
                              other: '其他',
                            }[video.qualityLimitationReason]
                          : '未提供'}
                      </Text>
                      {!!report.screenEncoder?.attempts.length && (
                        <Text style={styles.metric}>
                          编码尝试　
                          {report.screenEncoder.attempts
                            .map(
                              attempt =>
                                `${attempt.codec}${
                                  attempt.outcome === 'failed'
                                    ? `（失败：${attempt.reason ?? '未提供'}）`
                                    : '（已选择）'
                                }`,
                            )
                            .join(' → ')}
                        </Text>
                      )}
                    </>
                  )}
                  <Text style={styles.metric}>
                    视频码率　
                    {bitrate === null
                      ? '需再次刷新'
                      : `${(bitrate / 1000).toFixed(1)} kbps`}
                  </Text>
                  <Text style={styles.metric}>
                    收到／送出的视频帧　
                    {display(
                      video?.values.framesDecoded ??
                        video?.values.framesEncoded,
                    )}
                  </Text>
                  <Text style={styles.metric}>
                    丢包计数　{display(video?.values.packetsLost)}
                  </Text>
                </View>
                <Text style={styles.hint}>
                  当前：
                  {report.stage.sharing
                    ? '共享屏幕'
                    : report.stage.watching
                    ? '观看共享'
                    : report.stage.inVoice
                    ? '语音中'
                    : '未连接媒体'}
                  。手机采集目标为 30 FPS；实际帧率取决于画面、编码器和设备。
                </Text>
                <Text style={styles.hint}>
                  导出只包含媒体数值和编码器信息，排除网络地址、账号与访问凭据。
                </Text>
              </>
            )}
            {!!error && <Text style={styles.error}>{error}</Text>}
            {!!notice && <Text style={styles.hint}>{notice}</Text>}
            <CoveButton
              title={busy ? '正在读取' : '刷新媒体状态'}
              disabled={busy || saving}
              onPress={() => {
                void refresh();
              }}
            />
            <CoveButton
              title={saving ? '正在保存' : '导出媒体状态 JSON'}
              disabled={!report || busy || saving}
              onPress={() => {
                void save();
              }}
              tone="secondary"
            />
            <CoveButton
              title="关闭媒体状态"
              onPress={onClose}
              tone="secondary"
            />
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 16,
      backgroundColor: colors.overlay,
    },
    card: {
      width: '100%',
      maxWidth: 560,
      maxHeight: '92%',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
    },
    content: { padding: 20, gap: 12 },
    title: { color: colors.text, fontSize: 20, fontWeight: '700' },
    hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
    metrics: { gap: 10, paddingVertical: 10 },
    metric: { color: colors.text, fontSize: 14, lineHeight: 21 },
    error: { color: colors.red, fontSize: 13, lineHeight: 19 },
  });
