// Real production controls and a local WebRTC loopback; no real room or microphone is used.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, MonitorPlay } from 'lucide-react';
import { CollapsibleMediaBanner } from '../../src/components/CollapsibleMediaBanner';
import { ScreenFullscreenControl } from '../../src/components/ScreenFullscreenControl';
import { createVoiceAudioOutput } from '../../src/audioDevices';
import { useScreenFullscreen } from '../../src/hooks/useScreenFullscreen';
import '../../src/index.css';

function Fixture() {
  const [active, setActive] = useState(true);
  const { screenContainerRef: screen, screenMaximized: maximized, nativeFullscreen: fullscreen,
    toggleFullscreen, toggleNativeFullscreen } = useScreenFullscreen(active);
  return <main className="h-full overflow-auto bg-zinc-950 text-white">
    <header className="flex h-16 items-center border-b border-white/10 px-5">媒体控件测试 · 使用真实组件
      <button data-testid="toggle-share" onClick={() => setActive(value => !value)}>切换共享状态</button>
    </header>
    <CollapsibleMediaBanner kind="screen">
      <MonitorPlay className="text-cyan-200" />
      <div className="min-w-0 flex-1"><p>2 位成员正在共享屏幕</p><p className="text-xs text-white/50">测试横幅位置及收回动画</p></div>
      <button className="rounded-xl bg-cyan-100 px-3 py-2 text-zinc-900">观看共享</button>
    </CollapsibleMediaBanner>
    {['小雨', '小林'].map(name => <CollapsibleMediaBanner kind="audio" key={name}>
      <AudioLines className="text-violet-200" />
      <div className="min-w-0 flex-1"><p>正在接收 {name} 共享的应用音频</p><p className="text-xs text-white/50">每条横幅独立收回</p></div>
      <input aria-label={`${name} 应用音频音量`} type="range" className="w-24 accent-violet-200" />
    </CollapsibleMediaBanner>)}
    {active && <div style={maximized ? { position: 'fixed', inset: 0, zIndex: 50 } : { height: 288, marginTop: 16 }}>
    <div ref={screen} className="cove-screen-container relative h-full bg-black" data-maximized={maximized}>
      <div className="flex h-full items-center justify-center text-white/40">全屏菜单鼠标路径测试</div>
      <ScreenFullscreenControl maximized={maximized} nativeFullscreen={fullscreen}
        onToggleWindow={toggleFullscreen}
        onToggleNative={() => { void toggleNativeFullscreen(); }} />
    </div>
    </div>}
  </main>;
}

export async function testVoiceAudioOutput() {
  const context = new AudioContext();
  const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
  const oscillator = context.createOscillator();
  const sent = context.createMediaStreamDestination();
  let output: ReturnType<typeof createVoiceAudioOutput> | undefined;
  try {
    await context.resume();
    const quiet = context.createGain(); quiet.gain.value = 0.05;
    oscillator.connect(quiet).connect(sent); oscillator.start();
    sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
    receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
    const received = new Promise<MediaStream>(resolve => { receiver.ontrack = event => resolve(new MediaStream([event.track])); });
    sender.addTrack(sent.stream.getAudioTracks()[0], sent.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription!);
    const stream = await received;
    output = createVoiceAudioOutput(context, stream, 0);
    await output.resume();
    const meter = context.createAnalyser();
    output.gain.connect(meter);
    const values: Array<{ volume: number; rms: number }> = [];
    for (const volume of [0, 1, 0.5, 2, 0.35, 0, 0.35]) {
      output.gain.gain.value = volume;
      await new Promise(resolve => setTimeout(resolve, 450));
      const data = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(data);
      values.push({ volume, rms: Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) });
    }
    output.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopped = new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(stopped);
    return {
      values,
      rmsAfterClose: Math.sqrt(stopped.reduce((sum, x) => sum + x * x, 0) / stopped.length),
      streamStillLiveAfterDisconnect: sent.stream.getAudioTracks()[0].readyState === 'live',
    };
  } finally {
    output?.close();
    sender.close(); receiver.close(); oscillator.stop();
    sent.stream.getTracks().forEach(track => track.stop());
    await context.close();
  }
}

createRoot(document.getElementById('root')!).render(<Fixture />);
