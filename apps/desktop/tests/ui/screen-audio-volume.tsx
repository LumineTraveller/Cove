/*
 * Remote screen-audio receive-volume probe.
 *
 * Mounts the real ChatRoomV2 with a deterministic in-page SFU double whose
 * remote peer publishes a screen video producer plus a `screen-audio` producer
 * (the shape a phone share produces). It then drives the real "共享观看音量"
 * slider and records what the app assigns to the playing element, together with
 * a calibrated measurement of how Chromium treats HTMLMediaElement.volume for a
 * MediaStream audio track. No server, account, microphone or speaker is needed.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Device } from "mediasoup-client";
import ChatRoomV2 from "../../src/features/rooms/ChatRoomV2";
import { socket } from "../../src/features/connection/socket";
import { applyTheme, type AppTheme } from "../../src/features/settings/theme";
import type { Message, RoomMember, RoomWithAppearance, VoiceMember } from "../../src/features/rooms/ChatRoomV2";
import "../../src/styles/index.css";

// ── 探针：记录应用对播放元素的每一次音量/静音写入 ──────────────────────────
const probe = {
  volumeSets: [] as { element: string; value: number; at: number }[],
  mutedSets: [] as { element: string; value: boolean; at: number }[],
  elementSources: [] as { element: string; ok: boolean; error?: string; at: number }[],
  boostGains: [] as GainNode[],
  streamSources: [] as { stream: MediaStream; node: AudioNode }[],
  streamGains: [] as { gain: GainNode; stream: MediaStream | null }[],
};
(window as any).screenAudioVolumeProbe = probe;

const elementTag = (element: HTMLMediaElement) =>
  `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/)[0]}` : ""}`;

for (const key of ["volume", "muted"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key)!;
  Object.defineProperty(HTMLMediaElement.prototype, key, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get(this: HTMLMediaElement) {
      return (descriptor.get as () => unknown).call(this);
    },
    set(this: HTMLMediaElement, value: never) {
      const record = { element: elementTag(this), value, at: Math.round(performance.now()) };
      if (key === "volume") probe.volumeSets.push(record as never);
      else probe.mutedSets.push(record as never);
      (descriptor.set as (next: unknown) => void).call(this, value);
    },
  });
}

const realCreateMediaElementSource = AudioContext.prototype.createMediaElementSource;
AudioContext.prototype.createMediaElementSource = function patched(this: AudioContext, element: HTMLMediaElement) {
  const entry = { element: elementTag(element), ok: false, error: undefined as string | undefined, at: Math.round(performance.now()) };
  probe.elementSources.push(entry);
  try {
    const node = realCreateMediaElementSource.call(this, element);
    entry.ok = true;
    return node;
  } catch (error) {
    entry.error = String(error);
    throw error;
  }
};

const realCreateMediaStreamSource = AudioContext.prototype.createMediaStreamSource;
AudioContext.prototype.createMediaStreamSource = function patched(this: AudioContext, stream: MediaStream) {
  const node = realCreateMediaStreamSource.call(this, stream);
  probe.streamSources.push({ stream, node });
  return node;
};

const realConnect = AudioNode.prototype.connect;
(AudioNode.prototype as unknown as { connect: typeof realConnect }).connect = function patched<T extends AudioNode>(
  this: AudioNode,
  destination: T,
  ...rest: unknown[]
): T {
  if (this instanceof MediaElementAudioSourceNode && destination instanceof GainNode)
    probe.boostGains.push(destination);
  if (this instanceof MediaStreamAudioSourceNode && destination instanceof GainNode)
    probe.streamGains.push({
      gain: destination,
      stream: probe.streamSources.find((item) => item.node === this)?.stream ?? null,
    });
  return (realConnect as unknown as (...args: unknown[]) => T).apply(this, [destination, ...rest]);
};

const api = "https://screen-audio-volume.invalid";
const roomId = "screen-audio-volume-room";
const flags = new URLSearchParams(location.search);
const now = Date.now();
const room: RoomWithAppearance = {
  id: roomId,
  name: "共享音量探针",
  createdAt: now,
  ownerName: "QA 自己",
  maxMembers: 8,
  hasPassword: false,
  isOwner: true,
  avatarUrl: null,
  // Loud, distinct colors make canvas bleed visible in the artifact captures.
  backgroundTop: "#d9e9ff",
  backgroundBottom: "#f8fbff",
  backgroundTopDark: "#071526",
  backgroundBottomDark: "#102a42",
};

const selfMember: RoomMember = {
  socketId: "qa-self",
  userId: "qa-account",
  username: "QA 自己",
  avatarUrl: null,
  isOwner: true,
  isMuted: false,
  platform: "desktop",
};
const peerMember: RoomMember = {
  socketId: "qa-peer",
  userId: "qa-peer-account",
  username: "共享者小雨",
  avatarUrl: null,
  isOwner: false,
  isMuted: false,
  platform: "mobile",
  isSharingScreen: true,
};
const voiceMembers: VoiceMember[] = [
  {
    socketId: selfMember.socketId,
    userId: selfMember.userId,
    username: selfMember.username,
    avatarUrl: null,
    isMuted: false,
  },
  {
    socketId: peerMember.socketId,
    userId: peerMember.userId,
    username: peerMember.username,
    avatarUrl: null,
    isMuted: false,
  },
];

const history: Message[] = [
  {
    id: "qa-history-1",
    roomId,
    author: "共享者小雨",
    content: "普通聊天室消息：共享前后仍然可以阅读。",
    type: "chat",
    timestamp: now - 60_000,
  },
  {
    id: "qa-history-2",
    roomId,
    author: "QA 自己",
    content: "共享聊天窄窗验收开始。",
    type: "chat",
    timestamp: now - 30_000,
  },
];

type Handler = (...args: any[]) => void;
type ProducerEntry = {
  id: string;
  peerId: string;
  kind: "audio" | "video";
  appData: Record<string, unknown>;
  track: MediaStreamTrack;
};

const requests: string[] = [];
const producers = new Map<string, ProducerEntry>();
let producerSerial = 0;
let currentSharedCanvas: HTMLCanvasElement | null = null;
let localSharedStream: MediaStream | null = null;
let remoteSharedStream: MediaStream | null = null;

const remoteCanvas = document.createElement("canvas");
remoteCanvas.width = 1280;
remoteCanvas.height = 720;
const remoteContext = remoteCanvas.getContext("2d")!;

function paintCanvas(canvas: HTMLCanvasElement, tone: "red" | "blue" | "green") {
  const context = canvas.getContext("2d")!;
  const colors = {
    red: ["#ff1738", "#35000c"],
    blue: ["#00a8ff", "#001d48"],
    green: ["#00df8a", "#002d24"],
  } as const;
  const [top, bottom] = colors[tone];
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(255,255,255,.94)";
  context.font = "700 54px sans-serif";
  context.fillText(`SYNTHETIC ${tone.toUpperCase()} SHARE`, 70, 135);
  context.font = "500 32px sans-serif";
  context.fillText("The chat panel must keep its own surface", 70, 195);
  context.strokeStyle = "rgba(255,255,255,.8)";
  context.lineWidth = 8;
  context.strokeRect(32, 32, canvas.width - 64, canvas.height - 64);
}

paintCanvas(remoteCanvas, "red");

function createSyntheticShareStream(tone: "red" | "blue" | "green" = "red") {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  canvas.dataset.shareQaCanvas = "local";
  paintCanvas(canvas, tone);
  const stream = canvas.captureStream(30);
  currentSharedCanvas = canvas;
  return stream;
}

remoteSharedStream = remoteCanvas.captureStream(30);
producers.set("qa-peer-screen", {
  id: "qa-peer-screen",
  peerId: peerMember.socketId,
  kind: "video",
  appData: { type: "screen", adaptation: "content" },
  track: remoteSharedStream.getVideoTracks()[0],
});

// 手机共享的系统声音：持续合成音，按手机端的 appData 形状发布。
const lateAudio = flags.has("late-audio");
const screenToneContext = new AudioContext();
const screenToneOscillator = screenToneContext.createOscillator();
const screenToneDestination = screenToneContext.createMediaStreamDestination();
const screenToneGain = screenToneContext.createGain();
screenToneGain.gain.value = 0.2;
screenToneOscillator.frequency.value = 320;
screenToneOscillator.connect(screenToneGain).connect(screenToneDestination);
screenToneOscillator.start();
const screenAudioProducer: ProducerEntry = {
  id: "qa-peer-screen-audio",
  peerId: peerMember.socketId,
  kind: "audio",
  appData: { type: "screen-audio", client: "android" },
  track: screenToneDestination.stream.getAudioTracks()[0],
};
if (!lateAudio) producers.set(screenAudioProducer.id, screenAudioProducer);

function setSharedTone(tone: "red" | "blue" | "green") {
  if (currentSharedCanvas) paintCanvas(currentSharedCanvas, tone);
  paintCanvas(remoteCanvas, tone);
}

function publish(event: string, ...args: unknown[]) {
  for (const listener of [...fake.listeners(event)]) listener.apply(fake, args);
}

function callbackOf(args: unknown[]): ((...result: any[]) => void) | undefined {
  const candidate = args[args.length - 1];
  return typeof candidate === "function" ? (candidate as (...result: any[]) => void) : undefined;
}

const fake = socket as any;
fake.id = selfMember.socketId;
fake.connected = true;
fake.recovered = true;
fake.connect = () => {
  fake.connected = true;
  queueMicrotask(() => publish("connect"));
  return fake;
};
fake.timeout = () => fake;
fake.emit = (event: string, ...args: unknown[]) => {
  requests.push(event);
  const data = args[0] as any;
  const callback = callbackOf(args);
  const ack = (result: unknown = null) => queueMicrotask(() => callback?.(result));
  const ackPair = (result: unknown = null) => queueMicrotask(() => callback?.(null, result));
  switch (event) {
    case "rooms:get":
      ackPair({ ok: true, rooms: [room] });
      break;
    case "room:join":
      ackPair({ ok: true });
      queueMicrotask(() =>
        publish("room:state", {
          roomId,
          name: room.name,
          ownerName: room.ownerName,
          isOwner: true,
          members: [selfMember, peerMember],
          maxMembers: room.maxMembers,
          hasPassword: false,
          backgroundTop: room.backgroundTop,
          backgroundBottom: room.backgroundBottom,
          backgroundTopDark: room.backgroundTopDark,
          backgroundBottomDark: room.backgroundBottomDark,
        }),
      );
      break;
    case "room:history":
      ackPair({ ok: true, messages: history, hasMore: false, cursor: null });
      break;
    case "voice:join":
      queueMicrotask(() => publish("voice:members-updated", voiceMembers));
      break;
    case "ms:capabilities":
      ack({ codecs: [], headerExtensions: [], fecMechanisms: [] });
      break;
    case "ms:create-transport":
      ack({
        id: `${data?.direction ?? "media"}-qa-transport`,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      });
      break;
    case "ms:connect-transport":
      ack(null);
      break;
    case "ms:produce": {
      const id = `qa-producer-${++producerSerial}`;
      ack({ producerId: id });
      break;
    }
    case "ms:get-producers":
      ack(
        [...producers.values()]
          .filter((producer) => producer.peerId !== fake.id)
          .map(({ id, peerId, kind, appData }) => ({
            producerId: id,
            peerId,
            kind,
            appData,
          })),
      );
      break;
    case "ms:consume": {
      const entry = producers.get(data?.producerId);
      if (!entry) ack({ error: "unknown QA producer" });
      else
        ack({
          id: `qa-consumer-${entry.id}`,
          producerId: entry.id,
          kind: entry.kind,
          rtpParameters: {},
          type: "simple",
        });
      break;
    }
    case "ms:resume-consumer":
      ack(null);
      break;
    case "message:send": {
      const message: Message = {
        id: `qa-message-${Date.now()}`,
        roomId,
        author: selfMember.username,
        content: String(data?.content ?? ""),
        type: "chat",
        timestamp: Date.now(),
      };
      queueMicrotask(() => publish("message:new", message));
      break;
    }
    case "ms:close-producer": {
      const id = String(data?.producerId ?? "");
      const entry = producers.get(id);
      if (entry) {
        producers.delete(id);
        queueMicrotask(() =>
          publish("ms:producer-closed", {
            producerId: id,
            peerId: entry.peerId,
            sourceType: entry.appData.type,
          }),
        );
      }
      break;
    }
    case "voice:leave":
    case "room:leave":
    case "voice:mute-state":
    case "ms:close-consumer":
    case "screen:demand":
      ack(null);
      break;
    default:
      if (callback) ack(null);
      break;
  }
  return fake;
};

class FakeProducer {
  id: string;
  track: MediaStreamTrack;
  appData: Record<string, unknown>;
  paused = false;
  closed = false;
  rtpSender = {
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async () => undefined,
  };
  private listeners = new Map<string, Handler[]>();

  constructor(id: string, track: MediaStreamTrack, appData: Record<string, unknown>) {
    this.id = id;
    this.track = track;
    this.appData = appData;
  }
  on(event: string, handler: Handler) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
  off(event: string, handler: Handler) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== handler));
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.listeners.get("transportclose") ?? []) handler();
  }
  async replaceTrack({ track }: { track: MediaStreamTrack }) {
    this.track = track;
  }
  async getStats() {
    return new Map<string, any>([
      ["outbound", { type: "outbound-rtp", kind: this.track.kind, bytesSent: 1024, packetsSent: 16 }],
      ["source", { type: "media-source", width: 1280, height: 720, framesPerSecond: 30 }],
    ]);
  }
}

class FakeConsumer {
  id: string;
  track: MediaStreamTrack;
  rtpReceiver = {};
  closed = false;
  private listeners = new Map<string, Handler[]>();
  constructor(id: string, track: MediaStreamTrack) {
    this.id = id;
    this.track = track;
  }
  on(event: string, handler: Handler) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
  off(event: string, handler: Handler) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== handler));
  }
  close() { this.closed = true; }
}

class FakeTransport {
  id: string;
  closed = false;
  private listeners = new Map<string, Handler[]>();
  constructor(id: string) { this.id = id; }
  on(event: string, handler: Handler) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
  private trigger(event: string, ...args: unknown[]) {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }
  async produce(options: any) {
    await new Promise<void>((resolve, reject) => {
      this.trigger("connect", { dtlsParameters: {} }, resolve, reject);
    });
    const id = await new Promise<string>((resolve, reject) => {
      this.trigger(
        "produce",
        {
          kind: options.track.kind,
          rtpParameters: {},
          appData: options.appData ?? {},
        },
        ({ id: producerId }: { id: string }) => resolve(producerId),
        reject,
      );
    });
    const producer = new FakeProducer(id, options.track, options.appData ?? {});
    producers.set(id, {
      id,
      peerId: fake.id,
      kind: options.track.kind,
      appData: options.appData ?? {},
      track: options.track,
    });
    return producer as any;
  }
  async consume(options: any) {
    const entry = producers.get(options.producerId);
    if (!entry) throw new Error(`Missing QA producer ${options.producerId}`);
    return new FakeConsumer(`qa-consumer-${entry.id}`, entry.track) as any;
  }
  close() { this.closed = true; }
}

// Keep mediasoup-client's import, but replace only the transport factory used
// by this fixture. This lets the production hook and all of its state paths run.
const devicePrototype = Device.prototype as any;
devicePrototype.load = async function load() {
  Object.defineProperty(this, "rtpCapabilities", {
    configurable: true,
    value: { codecs: [], headerExtensions: [], fecMechanisms: [] },
  });
};
devicePrototype.createSendTransport = function createSendTransport(params: any) {
  return new FakeTransport(params?.id ?? "qa-send-transport");
};
devicePrototype.createRecvTransport = function createRecvTransport(params: any) {
  return new FakeTransport(params?.id ?? "qa-recv-transport");
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(api)) return realFetch(input, init);
  if (url.endsWith(`/api/rooms/${roomId}`))
    return new Response(JSON.stringify(room), { headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/api/rooms"))
    return new Response(JSON.stringify([room]), { headers: { "Content-Type": "application/json" } });
  return new Response("Not found", { status: 404 });
};

const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
const testAudioContexts: AudioContext[] = [];
const audioMeterQa = new URLSearchParams(location.search).has("audio-meter");
const layoutAnimationQa = new URLSearchParams(location.search).has("layout-animation");
let sharedToneContext: AudioContext | undefined;
let sharedToneGain: GainNode | undefined;
if (audioMeterQa) {
  sharedToneContext = new AudioContext();
  const oscillator = sharedToneContext.createOscillator();
  sharedToneGain = sharedToneContext.createGain();
  sharedToneGain.gain.value = 0.04;
  const destination = sharedToneContext.createMediaStreamDestination();
  oscillator.frequency.value = 200;
  oscillator.connect(sharedToneGain).connect(destination);
  oscillator.start();
  producers.set("qa-peer-audio", {
    id: "qa-peer-audio", peerId: peerMember.socketId, kind: "audio",
    appData: { type: "application-audio", label: "合成共享音频" },
    track: destination.stream.getAudioTracks()[0],
  });
}
navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext();
  testAudioContexts.push(context);
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  oscillator.frequency.value = 220;
  oscillator.connect(destination);
  oscillator.start();
  return destination.stream;
};
navigator.mediaDevices.getDisplayMedia = async () => {
  localSharedStream = createSyntheticShareStream("red");
  return localSharedStream;
};

window.coveApplicationAudio = { stop: async () => undefined } as any;
window.coveScreenAudio = undefined;
window.coveRemoteControl = undefined;

const root = createRoot(document.getElementById("root")!);
const render = (theme: AppTheme) => {
  applyTheme(theme);
  flushSync(() =>
    root.render(
      <MemoryRouter initialEntries={[`/room/${roomId}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route
            path="/room/:roomId"
            element={
              <ChatRoomV2
                profile={{ username: selfMember.username, avatarUrl: null }}
                accountId={selfMember.userId}
                onProfileChange={() => undefined}
                onLogout={() => undefined}
                serverURL={api}
                sessionReady
                theme={theme}
                onThemeChange={applyTheme}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  );
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const findShareToggle = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="share-chat-toggle"], [aria-label*="聊天"], .share-chat-toggle, .strip-chat-button',
  );
const findChatPanel = () => document.querySelector<HTMLElement>(".chat-panel");
const state = {
  passed: false,
  results: [] as string[],
  screenshots: [] as string[],
  metrics: [] as Record<string, unknown>,
};
const check = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
  state.results.push(label);
};

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 0 }));
  element.click();
}

function setTone(tone: "red" | "blue" | "green") {
  setSharedTone(tone);
  window.dispatchEvent(new CustomEvent("share-chat-qa-tone", { detail: tone }));
}

(window as any).shareChatQa = {
  setTone,
  getSnapshot: () => {
    const panel = findChatPanel();
    const toggle = findShareToggle();
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const slot = panel?.parentElement;
    const slotStyle = slot ? getComputedStyle(slot) : null;
    const rect = toggle?.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      panelBackground: panelStyle?.backgroundColor ?? null,
      panelBackdrop: panelStyle?.backdropFilter ?? null,
      slotBackground: slotStyle?.backgroundColor ?? null,
      slotBackdrop: slotStyle?.backdropFilter ?? null,
      panelRect: panel?.getBoundingClientRect().toJSON() ?? null,
      toggleRect: rect?.toJSON() ?? null,
      toggleLabel: toggle?.getAttribute("aria-label") ?? toggle?.textContent?.trim() ?? null,
      toggleExpanded: toggle?.getAttribute("aria-expanded") ?? null,
      oldButtonCount: document.querySelectorAll(".strip-chat-button").length,
      requests: [...requests],
    };
  },
};

type Sample = {
  label: string;
  slider: number | null;
  elementVolume: number | null;
  elementMuted: boolean | null;
  elementPaused: boolean | null;
  audioTracks: number | null;
  boostGains: number | null;
  gainValue: number | null;
  measurement: string;
  rms: number | null;
  appGain: number | null;
  loopRms: number | null;
  loopPeak: number | null;
};

const samples: Sample[] = [];
const calibration: Record<string, unknown>[] = [];
const measurement = {
  analyser: null as AnalyserNode | null,
  kind: "none" as string,
};

const setSlider = (input: HTMLInputElement, value: number) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const measureAvg = async (analyser: AnalyserNode, ms = 700) => {
  const samples: number[] = [];
  const peaks: number[] = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    let peak = 0;
    for (const value of data) {
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    samples.push(Math.sqrt(sum / data.length));
    peaks.push(peak);
    await wait(24);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const mean = samples.reduce((total, value) => total + value, 0) / Math.max(1, samples.length);
  return { mean: Number(median.toFixed(5)), peak: Number(Math.max(...peaks).toFixed(5)), n: samples.length, meanRaw: Number(mean.toFixed(5)) };
};

const rmsOf = (analyser: AnalyserNode) => {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const value of data) sum += value * value;
  return Number(Math.sqrt(sum / data.length).toFixed(5));
};

const screenVideo = () =>
  document.querySelector<HTMLVideoElement>(".remote-video-surface video");
const shareSlider = () =>
  document.querySelector<HTMLInputElement>(
    ".share-status-bar .volume-control input[type=range]",
  );

function attachAnalyser(context: AudioContext, input: AudioNode) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  // AnalyserNode 只有被拉取时才有数据：接一个零增益负载到 destination。
  const sink = context.createGain();
  sink.gain.value = 0;
  input.connect(analyser);
  analyser.connect(sink).connect(context.destination);
  return analyser;
}

let loopAnalyser: AnalyserNode | null = null;
async function acquireLoopback() {
  try {
    const capture = await originalGetDisplayMedia({ video: true, audio: true });
    const track = capture.getAudioTracks()[0];
    capture.getVideoTracks().forEach((item) => item.stop());
    if (!track) {
      calibration.push({ loopback: 'no-audio-track' });
      return;
    }
    const context = new AudioContext();
    await context.resume();
    loopAnalyser = attachAnalyser(context, context.createMediaStreamSource(new MediaStream([track])));
    calibration.push({ loopback: track.label || 'ok' });
  } catch (error) {
    calibration.push({ loopbackError: String(error) });
  }
}

function screenGainEntry() {
  return (
    [...probe.streamGains]
      .reverse()
      .find((item) => item.stream?.getTracks().includes(screenAudioProducer.track)) ?? null
  );
}

function maybeAttachMeasurement() {
  if (measurement.analyser) return;
  // 最可靠的位置：应用自己的共享音频增益节点（页面内测量，不受系统噪声影响）。
  const shared = screenGainEntry();
  if (shared) {
    measurement.analyser = attachAnalyser(shared.gain.context, shared.gain);
    measurement.kind = "screen-gain";
    return;
  }
  // 其次复用应用建立的元素增强增益（>100% 通路）。
  const boost = probe.boostGains[probe.boostGains.length - 1];
  if (boost) {
    measurement.analyser = attachAnalyser(boost.context, boost);
    measurement.kind = "boost-gain";
    return;
  }
  if (!flags.has("tap")) return;
  const video = screenVideo();
  if (!video) return;
  try {
    const context = new AudioContext();
    const source = context.createMediaElementSource(video);
    measurement.analyser = attachAnalyser(context, source);
    source.connect(context.destination);
    void context.resume();
    measurement.kind = "element-tap";
  } catch (error) {
    measurement.kind = `element-tap-failed: ${String(error)}`;
  }
}

const record = async (label: string) => {
  await wait(160);
  maybeAttachMeasurement();
  await wait(120);
  const video = screenVideo();
  const gain = probe.boostGains[probe.boostGains.length - 1] ?? null;
  const loopMeasured = loopAnalyser ? await measureAvg(loopAnalyser) : null;
  samples.push({
    label,
    slider: shareSlider() ? Number(shareSlider()!.value) : null,
    elementVolume: video ? Number(video.volume.toFixed(4)) : null,
    elementMuted: video ? video.muted : null,
    elementPaused: video ? video.paused : null,
    audioTracks:
      video?.srcObject instanceof MediaStream
        ? video.srcObject.getAudioTracks().length
        : null,
    boostGains: probe.boostGains.length,
    gainValue: gain ? Number(gain.gain.value.toFixed(4)) : null,
    appGain: (() => {
      const shared = screenGainEntry();
      return shared ? Number(shared.gain.gain.value.toFixed(4)) : null;
    })(),
    measurement: measurement.kind,
    rms: measurement.analyser ? rmsOf(measurement.analyser) : null,
    loopRms: loopMeasured?.mean ?? null,
    loopPeak: loopMeasured?.peak ?? null,
  });
};

async function calibrateElementVolume() {
  // 校准 0：纯 Web Audio 通路，验证 rmsOf 与 analyser 拉取本身是否正常。
  const controlContext = new AudioContext();
  await controlContext.resume();
  const controlOscillator = controlContext.createOscillator();
  controlOscillator.frequency.value = 440;
  const controlAnalyser = attachAnalyser(controlContext, controlOscillator);
  controlOscillator.start();
  await wait(360);
  calibration.push({
    kind: "webaudio-control",
    state: controlContext.state,
    rms: rmsOf(controlAnalyser),
  });

  // 校准：Chromium 是否让 HTMLMediaElement.volume 真正影响 MediaStream 音轨输出。
  const toneContext = new AudioContext();
  await toneContext.resume();
  const oscillator = toneContext.createOscillator();
  const destination = toneContext.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  const streamAnalyser = attachAnalyser(toneContext, oscillator);
  await wait(320);
  calibration.push({ kind: "tone-source", rms: rmsOf(streamAnalyser) });
  const video = document.createElement("video");
  video.dataset.probe = "calibration";
  video.srcObject = new MediaStream([destination.stream.getAudioTracks()[0]]);
  document.body.append(video);
  const measureContext = new AudioContext();
  await measureContext.resume();
  try {
    const source = measureContext.createMediaElementSource(video);
    const analyser = attachAnalyser(measureContext, source);
    source.connect(measureContext.destination);
    await video
      .play()
      .catch((error: unknown) => calibration.push({ playError: String(error) }));
    await wait(360);
    for (const value of [1, 0.5, 0.25, 0]) {
      video.volume = value;
      await wait(260);
      calibration.push({ kind: "volume", value, rms: rmsOf(analyser) });
    }
    video.volume = 0.8;
    video.muted = true;
    await wait(260);
    calibration.push({ kind: "muted", value: true, rms: rmsOf(analyser) });
    video.muted = false;
    await wait(260);
    calibration.push({ kind: "muted", value: false, rms: rmsOf(analyser) });
    calibration.push({
      kind: "track",
      readyState: video.readyState,
      trackState: destination.stream.getAudioTracks()[0]?.readyState,
      trackMuted: destination.stream.getAudioTracks()[0]?.muted,
    });
  } catch (error) {
    calibration.push({ error: String(error) });
  }
  calibration.push({
    contextStates: { tone: toneContext.state, measure: measureContext.state },
    paused: video.paused,
  });

  // 校准 2：解码文件（非 MediaStream）的媒体元素在同一环境里是否有声。
  // 用它区分「媒体元素整体无声」与「MediaStream 的元素取不到声音」。
  try {
    const sampleRate = 8000;
    const frames = sampleRate; // 1 秒 440Hz
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1)
        view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + frames * 2, true);
    writeText(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, frames * 2, true);
    for (let index = 0; index < frames; index += 1)
      view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12000), true);
    const blobVideo = document.createElement("video");
    blobVideo.dataset.probe = "blob-calibration";
    blobVideo.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    blobVideo.loop = true;
    document.body.append(blobVideo);
    const blobContext = new AudioContext();
    await blobContext.resume();
    const blobSource = blobContext.createMediaElementSource(blobVideo);
    const blobAnalyser = attachAnalyser(blobContext, blobSource);
    blobSource.connect(blobContext.destination);
    await blobVideo.play().catch((error: unknown) => calibration.push({ blobPlayError: String(error) }));
    await wait(400);
    blobVideo.volume = 1;
    await wait(260);
    const full = rmsOf(blobAnalyser);
    blobVideo.volume = 0.25;
    await wait(260);
    const quarter = rmsOf(blobAnalyser);
    blobVideo.volume = 1;
    blobVideo.muted = true;
    await wait(260);
    const silenced = rmsOf(blobAnalyser);
    calibration.push({
      kind: "blob-element",
      paused: blobVideo.paused,
      readyState: blobVideo.readyState,
      rmsVolume1: full,
      rmsVolume025: quarter,
      rmsMuted: silenced,
    });
  } catch (error) {
    calibration.push({ blobError: String(error) });
  }
}

(window as any).screenAudioVolumeResult = (async () => {
  const preseed = flags.get("preseed");
  if (preseed) localStorage.setItem("cove_screen_receive_volume_v1", preseed);
  render("dark");
  await wait(320);

  const joinButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.title === "加入语音",
  );
  check(joinButton, "join voice control is available");
  click(joinButton!);
  await wait(850);

  const watchButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "观看共享",
  );
  check(watchButton, "remote watch control is available");
  click(watchButton!);
  await wait(900);
  check(document.querySelector(".mode-watching"), "remote-watch layout is active");

  if (lateAudio) {
    // 手机端在画面之后才发布系统声音，这里复现同一时序。
    producers.set(screenAudioProducer.id, screenAudioProducer);
    publish("ms:new-producer", {
      producerId: screenAudioProducer.id,
      peerId: screenAudioProducer.peerId,
      kind: screenAudioProducer.kind,
      appData: screenAudioProducer.appData,
    });
    await wait(800);
  }
  await screenToneContext.resume();
  await acquireLoopback();
  await wait(200);

  const input = shareSlider();
  const video = screenVideo();
  state.results.push(`slider=${Boolean(input)} video=${Boolean(video)}`);
  state.results.push(
    `audioTracks=${
      video?.srcObject instanceof MediaStream
        ? video.srcObject.getAudioTracks().length
        : "no-stream"
    }`,
  );

  await record("initial");
  for (const value of [100, 50, 25, 10, 0, 10, 50, 100, 150, 200, 120]) {
    if (!input) break;
    setSlider(input, value);
    await record(`slider-${value}`);
  }
  await calibrateElementVolume();

  state.metrics.push({
    flags: [...flags.keys()],
    samples,
    calibration,
    elementSources: probe.elementSources,
    boostGains: probe.boostGains.length,
    volumeSets: probe.volumeSets.slice(-120),
    mutedSets: probe.mutedSets.slice(-60),
  });
  state.passed = true;
  return state;
})().catch((error) => ({
  ...state,
  passed: false,
  error: String((error as Error)?.stack ?? error),
  metrics: [...state.metrics, { samples, calibration, elementSources: probe.elementSources }],
}));

void originalGetUserMedia;
void originalGetDisplayMedia;
void testAudioContexts;
