import { Radio, SquaresFour } from '@phosphor-icons/react';
import { useWebRTC } from '../useWebRTC';
import { isScreenEncodingWithinPlan, screenEncodingPlanLabel } from '../screen/screenCapture';
import { diagnosticPacketLoss, type FrameRateGap } from './mediaDiagnostics';
import { frameStabilityDetail, frameStabilityLabel } from './frameStabilityView';

const FRAME_RATE_STAGE_LABELS: Record<FrameRateGap['stage'], string> = {
  capture: '原生供帧',
  delivery: '原生轨道交付',
  'encoder-input': 'WebRTC 编码前输入',
  encode: '编码',
  send: 'RTP 发送',
  decode: '解码',
};

export function DiagnosticsOverlayV2({
  rtc,
  compact,
  onToggleCompact,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  compact: boolean;
  onToggleCompact: () => void;
}) {
  const resolution =
    rtc.stats.width && rtc.stats.height ? `${rtc.stats.width}×${rtc.stats.height}` : '—';
  const fps = rtc.localScreen ? rtc.stats.sendFps : rtc.stats.receiveFps;
  const sending = rtc.stats.role === 'sender' ||
    (rtc.stats.role === 'idle' && Boolean(rtc.localScreen));
  const { frameRateDiagnosis, qualityLimitation, captureBackend, nativeCaptureStartTimedOut } = rtc.stats;
  const encoderImplementation = rtc.stats.encoderImplementation ?? '';
  const encoderType = encoderImplementation.startsWith('MediaFoundationVideoEncodeAccelerator') ? 'GPU'
    : /^(?:libaom|libvpx)\b/i.test(encoderImplementation) ? 'CPU' : null;
  const qualityLabel = qualityLimitation === 'cpu' ? 'CPU'
    : qualityLimitation === 'bandwidth' ? '带宽'
    : qualityLimitation === 'other' ? '其他' : null;
  const frameRateStatus = {
    pending: '等待可比较的帧率样本',
    paused: sending ? '发送已暂停' : '接收已暂停',
    steady: sending ? '接近当前目标帧率' : '解码跟上接收',
    'awaiting-complete-frame': '已收到数据包，暂无完整帧',
  };
  const lowSample = sending ? rtc.stats.nativeDeliveryStability : rtc.stats.presentationStability;
  const lowRows = <>
    <div>
      <span title={`${sending ? '原生采集交付节奏，不等于纯采集或发送帧率。' : '当前视频提交到合成器的节奏，不等于物理屏幕扫描输出。'}${frameStabilityDetail(lowSample)}`}>
        {sending ? '原生交付 1% low' : '观看呈现 1% low'}
      </span>
      <b>{frameStabilityLabel(lowSample)}</b>
    </div>
    {!compact && sending && (
      <div>
        <span title={`本地预览提交到合成器的节奏，不等于远端观看体验。${frameStabilityDetail(rtc.stats.presentationStability)}`}>
          预览呈现 1% low
        </span>
        <b>{frameStabilityLabel(rtc.stats.presentationStability)}</b>
      </div>
    )}
  </>;
  return (
    <div className={`debug-overlay diagnostics-v2 ${compact ? 'compact' : ''}`}>
      <header>
        <Radio size={17} weight="fill" />
        媒体调试<span>{rtc.localScreen ? '共享方' : '观看方'}</span>
        <button
          className="icon-btn"
          onClick={onToggleCompact}
          aria-label={compact ? '显示详细诊断' : '显示精简诊断'}
        >
          <SquaresFour size={14} />
        </button>
        <button className="icon-btn" onClick={rtc.exportMediaDiagnostics} aria-label="导出媒体诊断" title="导出媒体诊断">导出</button>
      </header>
      {compact ? (
        <>
          <div>
            <span>帧率</span>
            <b>{fps ?? '—'} fps</b>
          </div>
          <div>
            <span>分辨率</span>
            <b>{resolution}</b>
          </div>
          {lowRows}
          <div>
            <span>码率</span>
            <b>{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</b>
          </div>
        </>
      ) : (
        <>
          <div>
            <span
              title={rtc.localScreen
                ? '报告为轨道声明帧率。源统计 WebRTC 编码前收到的视频帧。'
                : '接收和解码分别表示对应阶段的视频帧率。'}
            >
              {rtc.localScreen ? '报告/源/编码/发送' : '接收/解码'}
            </span>
            <b>
              {rtc.localScreen
                ? `${rtc.stats.trackFps ?? '—'} / ${rtc.stats.captureFps ?? '—'} / ${
                    rtc.stats.encodeFps ?? '—'
                  } / ${rtc.stats.sendFps ?? '—'}`
                : `${rtc.stats.receiveFps ?? '—'} / ${rtc.stats.decodeFps ?? '—'}`}{' '}
              fps
            </b>
          </div>
          {sending && captureBackend === 'native-gpu' && (
            <div>
              <span title="从原生组件收到的帧率与写入共享轨道的帧率">原生收到/交付</span>
              <b>{rtc.stats.nativeCaptureFps ?? '—'} / {rtc.stats.nativeDeliveryFps ?? '—'} fps</b>
            </div>
          )}
          <div>
            <span>原始/编码/档位</span>
            <b>
              {rtc.stats.trackWidth && rtc.stats.trackHeight
                ? `${rtc.stats.trackWidth}×${rtc.stats.trackHeight}`
                : '—'}{' '}
              / {resolution} /{' '}
              {rtc.localScreen && rtc.screenEncodingPlan
                ? `${rtc.screenEncodingPlan.outputWidth}×${rtc.screenEncodingPlan.outputHeight}`
                : '—'}
            </b>
          </div>
          {lowRows}
          <div>
            <span>编码器</span>
            <b title={encoderImplementation || undefined}>
              {rtc.stats.codec ?? '—'}
              {encoderType ? ` · ${encoderType}` : ''}
            </b>
          </div>
          <div>
            <span>RTP 码率</span>
            <b>{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</b>
          </div>
          <div>
            <span>服务器入口/出口</span>
            <b>
              {rtc.stats.serverIngressBitrate ?? '—'} / {rtc.stats.serverEgressBitrate ?? '—'} kbps
            </b>
          </div>
          <div>
            <span title="客户端与 SFU 的往返时间；不代表采集到显示的端到端延迟">RTT / RTP 抖动</span>
            <b>
              {rtc.stats.rtt ?? '—'} / {rtc.stats.jitter ?? '—'} ms
            </b>
          </div>
          <div>
            <span>丢包/重传</span>
            <b>
              {diagnosticPacketLoss(rtc.stats) ?? '—'}% / {rtc.stats.retransmitBitrate ?? '—'} kbps
            </b>
          </div>
          {frameRateDiagnosis?.status === 'limited' ? frameRateDiagnosis.gaps.map(gap => (
            <div key={gap.stage}>
              <span title="同一采样区间内的实际帧率 / 该阶段参考帧率">
                帧率受限 · {FRAME_RATE_STAGE_LABELS[gap.stage]}
              </span>
              <b>{gap.observedFps} / {gap.referenceFps} fps</b>
            </div>
          )) : (
            <div>
              <span>帧率受限</span>
              <b>{frameRateStatus[frameRateDiagnosis?.status ?? 'pending']}</b>
            </div>
          )}
          {rtc.stats.droppedFrames != null && (
            <div>
              <span>掉帧</span>
              <b>{rtc.stats.droppedFrames} 帧/秒</b>
            </div>
          )}
          {qualityLabel && (
            <div>
              <span title="WebRTC 对分辨率或帧率进行质量调节的原因">WebRTC 质量调节</span>
              <b>{qualityLabel}</b>
            </div>
          )}
          {captureBackend && (
            <div>
              <span>采集后端</span>
              <b>{captureBackend === 'native-gpu' ? 'Cove 原生' : 'Chromium'}
                {nativeCaptureStartTimedOut && ' · 原生启动超时'}</b>
            </div>
          )}
          <div>
            <span>协议/来源</span>
            <b>
              {rtc.stats.protocol ?? '—'} / {rtc.stats.displaySurface ?? '—'}
            </b>
          </div>
          {rtc.localScreen && (
            <div>
              <span>档位检查</span>
              <b>
                {screenEncodingPlanLabel(
                  isScreenEncodingWithinPlan(
                    rtc.stats.width,
                    rtc.stats.height,
                    rtc.screenEncodingPlan,
                  ),
                )}
              </b>
            </div>
          )}
        </>
      )}
    </div>
  );
}
