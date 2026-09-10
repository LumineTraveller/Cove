/*
 * Shared-chat layout QA fixture.
 *
 * This deliberately mounts the real ChatRoomV2 and its real CSS/WebRTC hook.
 * The socket, SFU and capture devices below are deterministic in-page doubles;
 * no network server, user account or microphone is touched by this fixture.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Device } from "mediasoup-client";
import ChatRoomV2 from "../../src/pages/ChatRoomV2";
import { socket } from "../../src/socket";
import { applyTheme, type AppTheme } from "../../src/theme";
import type { Message, RoomMember, RoomWithAppearance, VoiceMember } from "../../src/pages/ChatRoomV2";
import "../../src/index.css";

const api = "https://share-chat-qa.invalid";
const roomId = "share-chat-qa-room";
const now = Date.now();
const room: RoomWithAppearance = {
  id: roomId,
  name: "共享聊天验收",
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
  platform: "desktop",
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
window.coveRemoteControl = { supported: false } as any;

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

(window as any).shareChatQaResult = (async () => {
  render("dark");
  await wait(300);
  check(findChatPanel(), "real ChatRoomV2 ordinary chat mounted");
  check(document.body.textContent?.includes("普通聊天室消息"), "history message is visible");
  const textarea = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
  check(textarea, "ordinary chat composer is present");
  textarea!.value = "fixture ordinary message";
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(80);
  check(document.body.textContent?.includes("fixture ordinary message"), "ordinary chat message sends through fake socket");

  const joinButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === "加入语音");
  check(joinButton, "join voice control is available");
  click(joinButton!);
  await wait(750);
  check(document.querySelector(".control-ball.voice-active"), "voice branch is active");

  const shareButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === "共享屏幕");
  check(shareButton, "self-share control is available");
  click(shareButton!);
  await wait(80);
  const shareConfirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "开始共享");
  check(shareConfirm, "screen share settings dialog is open");
  click(shareConfirm!);
  await wait(900);
  check(document.querySelector(".mode-self"), "self-share layout branch is active");
  check(findChatPanel(), "self-share chat remains mounted");

  const firstShareSnapshot = (window as any).shareChatQa.getSnapshot();
  check(firstShareSnapshot.panelBackground && !/rgba?\([^)]*,\s*0(?:\.0+)?\)/.test(firstShareSnapshot.panelBackground), "self-share panel has an opaque computed background");
  check(!String(firstShareSnapshot.panelBackdrop).includes("blur"), "self-share panel does not blur the shared canvas");
  check(firstShareSnapshot.slotBackground && !/rgba?\([^)]*,\s*0(?:\.0+)?\)/.test(firstShareSnapshot.slotBackground), "shared chat slot has its own surface");
  state.metrics.push(firstShareSnapshot);

  // Validate actual hit-testing and keyboard semantics at every target width.
  // The runner changes the native content size and records the artifacts.
  const toggle = findShareToggle();
  check(toggle, "shared-chat toggle is rendered in self-share mode");
  toggle!.focus();
  toggle!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(120);
  check(document.querySelector(".chat-panel") === null || document.querySelector(".chat-panel")?.getBoundingClientRect().width === 0 || document.querySelector(".chat-panel")?.offsetParent === null, "keyboard activation can collapse shared chat");
  toggle!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(120);
  check(findChatPanel(), "keyboard activation can expand shared chat");

  const endSelf = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "结束共享");
  check(endSelf, "self-share end control is available");
  click(endSelf!);
  await wait(450);
  check(!document.querySelector(".mode-self"), "self-share branch can exit");

  const watchButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "观看共享");
  check(watchButton, "remote watch control is available");
  click(watchButton!);
  await wait(850);
  check(document.querySelector(".mode-watching"), "remote-watch layout branch is active");
  check(findChatPanel(), "remote-watch chat is mounted");
  const watchSnapshot = (window as any).shareChatQa.getSnapshot();
  check(watchSnapshot.panelBackground && !/rgba?\([^)]*,\s*0(?:\.0+)?\)/.test(watchSnapshot.panelBackground), "remote-watch panel has an opaque computed background");
  check(!String(watchSnapshot.panelBackdrop).includes("blur"), "remote-watch panel does not blur the shared canvas");
  state.metrics.push(watchSnapshot);

  const watchToggle = findShareToggle();
  check(watchToggle, "shared-chat toggle is rendered in remote-watch mode");
  const watchRect = watchToggle!.getBoundingClientRect();
  const hit = document.elementFromPoint(watchRect.left + watchRect.width / 2, watchRect.top + watchRect.height / 2);
  check(Boolean(hit && watchToggle!.contains(hit)), "remote-watch toggle passes elementFromPoint hit-test");
  click(watchToggle!);
  await wait(120);
  check(!findChatPanel() || findChatPanel()!.offsetParent === null, "remote-watch toggle collapses chat by pointer");
  click(findShareToggle()!);
  await wait(120);
  check(findChatPanel(), "remote-watch toggle expands chat by pointer");

  // Give the runner a deterministic handle for changing the synthetic frame
  // between captures. It also verifies that the layout stays stable while the
  // underlying canvas flips from red to blue.
  setTone("red");
  await wait(100);
  setTone("blue");
  await wait(100);
  const afterTone = (window as any).shareChatQa.getSnapshot();
  check(afterTone.panelBackground === watchSnapshot.panelBackground, "shared-canvas tone changes do not change chat background style");
  state.metrics.push(afterTone);

  state.passed = true;
  return state;
})().catch((error) => ({
  ...state,
  passed: false,
  error: String(error?.stack ?? error),
}));

void originalGetUserMedia;
void originalGetDisplayMedia;
void testAudioContexts;
