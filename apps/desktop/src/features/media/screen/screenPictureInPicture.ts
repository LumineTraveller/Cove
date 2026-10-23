export interface ScreenPictureInPictureState {
  supported: boolean;
  active: boolean;
  pending: boolean;
  error: string | null;
}

interface PresentationRequest {
  video: HTMLVideoElement;
  source: MediaStream;
  epoch: number;
  returnOnClose: boolean;
  returned: boolean;
  cleanup?: Promise<void>;
}

/** Own presentation only. The original element, audio routing and tracks stay with WebRTC. */
export function createScreenPictureInPicture({ document: page, getVideo, onState, onReturn }: {
  document: Document;
  getVideo: () => HTMLVideoElement | null;
  onState: (state: ScreenPictureInPictureState) => void;
  onReturn: () => void;
}) {
  let source: MediaStream | null = null;
  let epoch = 0;
  let disposed = false;
  let opening: Promise<void> | null = null;
  let returning: Promise<void> | null = null;
  let intent: PresentationRequest | null = null;
  let closing: { video: HTMLVideoElement; promise: Promise<void> | null } | null = null;
  let state: ScreenPictureInPictureState = {
    supported: page.pictureInPictureEnabled === true && typeof page.exitPictureInPicture === 'function',
    active: false, pending: false, error: null,
  };
  const publish = (patch: Partial<ScreenPictureInPictureState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    onState({ ...state });
  };
  const current = (request: PresentationRequest) => !disposed && request.epoch === epoch &&
    source === request.source && getVideo() === request.video && request.video.srcObject === request.source;
  const returnOnce = (request: PresentationRequest) => {
    if (disposed || request.returned || source !== request.source) return;
    request.returned = true;
    onReturn();
  };
  const exitOwned = (video: HTMLVideoElement): Promise<void> => {
    if (closing?.video === video && closing.promise) return closing.promise;
    if (page.pictureInPictureElement !== video) return Promise.resolve();
    // Mark the exit before invoking Chromium: leave can arrive before its promise settles.
    const exit = { video, promise: null as Promise<void> | null };
    closing = exit;
    publish({ pending: true });
    let result: Promise<void>;
    try { result = page.exitPictureInPicture(); }
    catch (error) { result = Promise.reject(error); }
    exit.promise = result.finally(() => {
      if (closing === exit) closing = null;
      publish({ pending: opening !== null });
    });
    return exit.promise;
  };
  const exitCancelled = (request: PresentationRequest): Promise<void> => {
    if (request.cleanup) return request.cleanup;
    if (page.pictureInPictureElement !== request.video && closing?.video !== request.video) return Promise.resolve();
    request.cleanup = exitOwned(request.video).then(() => {
      if (request.returnOnClose) returnOnce(request);
    });
    return request.cleanup;
  };
  const cancelledExitFailed = (request: PresentationRequest) => {
    if (intent === request && page.pictureInPictureElement === request.video) publish({
      active: true, error: '小窗未能关闭，请使用小窗的关闭按钮。',
    });
  };
  const onEnter = (event: Event) => {
    const request = intent;
    if (!request || event.target !== request.video) return;
    if (current(request)) publish({ active: true });
    else void exitCancelled(request).catch(() => cancelledExitFailed(request));
  };
  const onLeave = (event: Event) => {
    const request = intent;
    if (!request || event.target !== request.video) return;
    const programmatic = closing?.video === request.video;
    // Chromium clears pictureInPictureElement after dispatch. Deferring also
    // ignores an old leave event delivered after this element entered again.
    queueMicrotask(() => {
      if (disposed || intent !== request || page.pictureInPictureElement === request.video) return;
      const userClosed = !programmatic && source === request.source && getVideo() === request.video;
      if (userClosed) epoch++;
      publish({ active: false });
      if (userClosed) returnOnce(request);
    });
  };
  page.addEventListener('enterpictureinpicture', onEnter);
  page.addEventListener('leavepictureinpicture', onLeave);
  onState({ ...state });

  return {
    setSource(next: MediaStream | null) {
      if (disposed || source === next) return;
      source = next;
      const changed = ++epoch;
      const previous = intent;
      if (previous) {
        previous.returnOnClose = false;
        void exitOwned(previous.video).catch(() => {
          if (epoch === changed && intent === previous) publish({
            active: page.pictureInPictureElement === previous.video,
            error: '小窗未能关闭，请使用小窗的关闭按钮。',
          });
        });
      }
      publish({ active: false, error: null });
    },
    open(): Promise<void> {
      // Retain this latch across source changes: an old native request must settle first.
      if (opening) return opening;
      if (returning) return returning;
      if (closing?.promise) return closing.promise.catch(() => {});
      if (disposed || !source) return Promise.resolve();
      const video = getVideo();
      if (!state.supported || (video && typeof video.requestPictureInPicture !== 'function')) {
        publish({ supported: false, error: '当前环境暂不支持置顶小窗。' });
        return Promise.resolve();
      }
      if (!video || video.srcObject !== source || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        publish({ error: '共享画面正在准备，请稍后再试。' });
        return Promise.resolve();
      }
      if (page.pictureInPictureElement === video) return Promise.resolve();
      const request = { video, source, epoch: ++epoch, returnOnClose: false, returned: false };
      intent = request;
      publish({ pending: true, error: null });
      let native: Promise<PictureInPictureWindow>;
      // Keep the call in the user's click stack; no IPC/await may consume user activation.
      try { native = video.requestPictureInPicture(); }
      catch (error) { native = Promise.reject(error); }
      const operation = native.then(async () => {
        if (!current(request)) await exitCancelled(request);
        else publish({ active: page.pictureInPictureElement === video });
      }).catch(() => {
        if (current(request)) publish({ active: page.pictureInPictureElement === video,
          error: '暂时无法打开置顶小窗，请重试。' });
        else cancelledExitFailed(request);
      }).finally(() => {
        if (opening === operation) opening = null;
        publish({ pending: false });
      });
      opening = operation;
      return operation;
    },
    close(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (returning) return returning;
      const request = intent;
      if (!request) return Promise.resolve();
      const cancelled = ++epoch;
      request.returnOnClose = true;
      if (opening) return opening;
      if (closing?.video === request.video && closing.promise) return closing.promise;
      if (page.pictureInPictureElement !== request.video) return Promise.resolve();
      publish({ pending: true, error: null });
      const operation = exitOwned(request.video).then(() => {
        if (epoch !== cancelled || intent !== request) return;
        publish({ active: false });
        if (request.returnOnClose) returnOnce(request);
      }).catch(() => {
        if (epoch === cancelled && intent === request) publish({ active: page.pictureInPictureElement === request.video,
          error: '暂时无法关闭小窗，请重试或使用小窗的关闭按钮。' });
      }).finally(() => {
        if (returning === operation) returning = null;
        publish({ pending: opening !== null || closing !== null });
      });
      returning = operation;
      return operation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      source = null;
      page.removeEventListener('enterpictureinpicture', onEnter);
      page.removeEventListener('leavepictureinpicture', onLeave);
      if (intent) {
        intent.returnOnClose = false;
        void exitOwned(intent.video).catch(() => {});
      }
    },
  };
}
