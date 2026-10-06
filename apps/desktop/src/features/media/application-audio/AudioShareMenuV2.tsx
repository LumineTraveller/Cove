import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  AppWindow,
  ArrowClockwise,
  Waveform as AudioLines,
  Headphones,
  CircleNotch as LoaderCircle,
  X,
} from '@phosphor-icons/react';
import type { ApplicationAudioSource } from './applicationAudio';

export function AudioShareMenuV2({
  sources,
  loading,
  error,
  onClose,
  onRefresh,
  onSystemAudio,
  onApplicationAudio,
}: {
  sources: ApplicationAudioSource[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onSystemAudio: () => void;
  onApplicationAudio: (source: ApplicationAudioSource) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const listHeightRef = useRef<number | null>(null);
  const listAnimationRef = useRef<Animation | null>(null);

  // 列表内容高度变化时（首次载入、刷新后项数变化）让高度平滑过渡，弹窗随之拉长，
  // 而不是一帧跳到位。
  //
  // 这里量的是 offsetHeight（当前已渲染高度），不是 scrollHeight：内容超出弹窗
  // max-height 时（8 项约 734px > 可用 570px），scrollHeight 会给出一个够不到的自然
  // 高度，动画会在头 100ms 内就撞上 flex 收缩的上限然后静止，缓动等于白给；改用已
  // 渲染高度当目标，缓动才真正作用在可见的增长上。offsetHeight 也不受祖先 transform
  // 影响，弹窗入场时的 scale 不会污染测量。
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const next = element.offsetHeight;
    const previous = listHeightRef.current;
    listHeightRef.current = next;
    // offsetHeight 取整，留 1px 容差避免抖动触发无意义的过渡。
    if (previous === null || Math.abs(previous - next) < 1) return;
    // 尊重系统的「减少动态效果」：跳过过渡，直接呈现终态。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    listAnimationRef.current?.cancel();
    listAnimationRef.current = element.animate(
      [{ height: `${previous}px` }, { height: `${next}px` }],
      // 与 --ease-layout 取值一致：起步快、末端平稳收住。
      { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [sources, loading]);

  useEffect(() => () => listAnimationRef.current?.cancel(), []);

  return (
    <div
      className="audio-popover-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="tool-menu audio-menu audio-share-modal popover-card"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-share-title"
      >
        <header className="audio-share-header">
          <div className="audio-share-heading">
            <span className="audio-share-heading-icon">
              <AudioLines size={25} weight="bold" />
            </span>
            <div>
              <h2 id="audio-share-title">共享应用音频</h2>
              <p>仅发送所选应用及其子进程的声音，不包含 Cove 通话或其他系统声音。</p>
            </div>
          </div>
          <button
            className="icon-btn audio-share-close"
            onClick={onClose}
            aria-label="关闭应用音频选择"
          >
            <X size={18} />
          </button>
        </header>
        <div className="audio-share-meta">
          <span>Windows 11 · 仅音频 · 共享后可调节发送音量</span>
          <button
            type="button"
            className="audio-share-refresh"
            onClick={onRefresh}
            disabled={loading}
          >
            <ArrowClockwise size={17} className={loading ? 'spin' : ''} />
            刷新
          </button>
        </div>
        <div className="audio-share-list" ref={listRef}>
          <button
            type="button"
            className="source-option system-audio-option"
            style={{ '--i': 0 } as React.CSSProperties}
            onClick={onSystemAudio}
          >
            <span className="source-option-icon">
              <Headphones size={20} />
            </span>
            <span className="source-option-copy">
              <b>全部系统音频</b>
              <small>排除 Cove 后共享电脑其他应用的声音</small>
            </span>
            <span className="source-option-action" aria-hidden="true">
              <AudioLines size={19} weight="bold" />
            </span>
          </button>
          {/* 刷新时 sources 仍持有上一次的列表，这时不切回转圈，避免列表先塌陷再长回来；
              只有首次载入（还没有任何内容可显示）才展示加载态。 */}
          {error ? (
            <div className="audio-share-empty" role="alert">
              <span>无法读取应用音频列表。</span>
              <small>{error}</small>
            </div>
          ) : loading && sources.length === 0 ? (
            <div className="audio-share-loading">
              <LoaderCircle className="spin" size={19} />
              正在读取可共享的应用…
            </div>
          ) : sources.length > 0 ? (
            sources.map((source, index) => (
              <button
                type="button"
                key={source.id}
                className="source-option"
                // 逐条入场的序号（系统音频占 0）。封顶 12：否则 20 个应用会让末尾
                // 等将近一秒。在 JS 里夹取而不是用 CSS min()，避免依赖
                //「min() 接受无单位数值」这一行为 —— 一旦不支持，整条
                // animation-delay 会被丢弃，stagger 静默失效。
                style={{ '--i': Math.min(index + 1, 12) } as React.CSSProperties}
                onClick={() => onApplicationAudio(source)}
              >
                <span className="source-option-icon">
                  {source.iconDataUrl ? (
                    <img src={source.iconDataUrl} alt="" draggable={false} />
                  ) : (
                    <AppWindow size={20} />
                  )}
                </span>
                <span className="source-option-copy">
                  <b>{source.name}</b>
                  <small>
                    {source.processName} · PID {source.processId}
                  </small>
                </span>
                <span className="source-option-action" aria-hidden="true">
                  <AudioLines size={19} weight="bold" />
                </span>
              </button>
            ))
          ) : (
            <div className="audio-share-empty">
              <AppWindow size={22} />
              <span>没有可共享音频的应用。</span>
              <small>请先打开应用或播放音频，再点击刷新；后台播放器也支持。</small>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
