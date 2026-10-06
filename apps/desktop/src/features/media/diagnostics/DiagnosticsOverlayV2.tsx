import { Radio, SquaresFour } from '@phosphor-icons/react';
import { useWebRTC } from '../useWebRTC';
import { isScreenEncodingWithinPlan, screenEncodingPlanLabel } from '../screen/screenCapture';
import { diagnosticPacketLoss } from './mediaDiagnostics';

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
          <div>
            <span>码率</span>
            <b>{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</b>
          </div>
        </>
      ) : (
        <>
          <div>
            <span>帧率</span>
            <b>
              {rtc.localScreen
                ? `${rtc.stats.trackFps ?? '—'} / ${rtc.stats.captureFps ?? '—'} / ${
                    rtc.stats.encodeFps ?? '—'
                  } / ${rtc.stats.sendFps ?? '—'}`
                : `${rtc.stats.receiveFps ?? '—'} / ${rtc.stats.decodeFps ?? '—'}`}{' '}
              fps
            </b>
          </div>
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
          <div>
            <span>编码器</span>
            <b>{rtc.stats.codec ?? '—'}</b>
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
            <span>延迟/抖动</span>
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
          <div>
            <span>掉帧/受限原因</span>
            <b>
              {rtc.stats.droppedFrames ?? '—'} / {rtc.stats.qualityLimitation ?? '—'}
            </b>
          </div>
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
