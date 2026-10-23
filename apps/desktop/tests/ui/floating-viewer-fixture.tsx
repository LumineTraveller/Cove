// Loaded only by media-integration.html?floating=1. Media remains owned by the
// real useWebRTC hook; this adapter mounts the production presentation subtree.
import { useEffect, useRef, useState } from 'react';
import { ShareViewV2 } from '../../src/features/media/screen/ShareViewV2';
import { socket, getServerURL } from '../../src/features/connection/socket';
import type { useWebRTC } from '../../src/features/media/useWebRTC';
import { CLIENT_PROTOCOL_VERSION, CLIENT_RELEASE_VERSIONS } from '@cove/contracts';
import '../../src/styles/index.css';
import '../../src/styles/ui-v2.css';

type RTC = ReturnType<typeof useWebRTC>;
type Control = 'available' | 'pending' | 'active' | 'unsupported';
let unmountFixture = () => {};
export function installFixtureUnmount(unmount: () => void) { unmountFixture = unmount; }
export function fixtureSocket(base: string) {
  // ShareViewV2's annotation hooks import this same product socket singleton.
  if (getServerURL() !== base) throw new Error('Floating fixture socket must use its owned backend');
  socket.auth = { clientProtocol: CLIENT_PROTOCOL_VERSION, clientPlatform: 'desktop', clientVersion: CLIENT_RELEASE_VERSIONS.desktop };
  return socket;
}
export function FloatingView({ rtc, roomId }: { rtc: RTC; roomId: string }) {
  const [mounted, setMounted] = useState(true);
  const [control, setControl] = useState<Control>('available');
  const [replacement, setReplacement] = useState<{ original: MediaStream; stream: MediaStream } | null>(null);
  const inputs = useRef(0);
  const events = useRef({ enter: 0, leave: 0 });
  const baseline = useRef<{ video: HTMLVideoElement; stream: MediaStream; tracks: MediaStreamTrack[] } | null>(null);
  useEffect(() => {
    const enter = () => { events.current.enter++; };
    const leave = () => { events.current.leave++; };
    document.addEventListener('enterpictureinpicture', enter, true);
    document.addEventListener('leavepictureinpicture', leave, true);
    return () => { document.removeEventListener('enterpictureinpicture', enter, true); document.removeEventListener('leavepictureinpicture', leave, true); };
  }, []);
  const remote = rtc.remoteScreen;
  const presentation = remote && replacement?.original === remote.stream
    ? { ...rtc, remoteScreen: { ...remote, stream: replacement.stream } } : rtc;
  useEffect(() => {
    (window as any).coveFloatingQA = {
      unmountFixture,
      setMounted,
      setControl,
      // A real MediaStream replacement using the live SFU tracks verifies the
      // presentation boundary without replacing consumers or stopping tracks.
      replaceStream: () => { if (remote) setReplacement({ original: remote.stream, stream: new MediaStream(remote.stream.getTracks()) }); },
      capture: () => {
        const video = document.querySelector<HTMLVideoElement>('.share-view video');
        if (!video || !(video.srcObject instanceof MediaStream)) throw new Error('No production video');
        baseline.current = { video, stream: video.srcObject, tracks: video.srcObject.getTracks() };
      },
      snapshot: () => {
        const video = document.querySelector<HTMLVideoElement>('.share-view video');
        const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
        const original = baseline.current;
        return {
          mounted, control, active: Boolean(document.pictureInPictureElement),
          sameVideo: Boolean(original && video === original.video), sameStream: Boolean(original && stream === original.stream),
          sameTracks: Boolean(original && stream && original.tracks.length === stream.getTracks().length && original.tracks.every((track, index) => track === stream.getTracks()[index])),
          pictureElementIsVideo: Boolean(video && document.pictureInPictureElement === video),
          videos: document.querySelectorAll('video').length, audioElements: document.querySelectorAll('audio').length,
          readyState: video?.readyState, width: video?.videoWidth, muted: video?.muted,
          liveTracks: stream?.getTracks().filter(track => track.readyState === 'live').length ?? 0,
          floatingPressed: document.querySelector('.floating-view-toggle')?.getAttribute('aria-pressed'),
          floatingDisabled: document.querySelector<HTMLButtonElement>('.floating-view-toggle')?.disabled,
          floatingError: document.querySelector('.screen-floating-error')?.textContent ?? null,
          operations: document.querySelectorAll('.share-operations').length,
          annotations: document.querySelectorAll('.screen-annotation-layer,.annotation-toolbar,.annotation-tool-ball').length,
          fullscreenDisabled: [...document.querySelectorAll<HTMLButtonElement>('.fullscreen-stack button')].every(button => button.disabled),
          inputs: inputs.current, events: { ...events.current },
        };
      },
    };
  });
  return mounted ? <div style={{height:'calc(100vh - 52px)',padding:12}}><ShareViewV2 rtc={presentation} roomId={roomId} debug={false} onToggleDebug={() => {}}
    remoteControl={{ state: control }} sharerName="Synthetic publisher" onInput={() => { inputs.current++; }}
    onRequestRemote={() => setControl('pending')} onStopRemote={() => setControl('available')}
    onEnd={() => { if (rtc.remoteScreen) rtc.stopWatchingScreen(); else rtc.stopScreenShare(); }}
    diagnosticsCompact onToggleDiagnosticsCompact={() => {}} /></div> : null;
}
