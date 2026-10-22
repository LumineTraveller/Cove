export interface ScreenPublication {
  socketId: string;
  videoProducerId: string;
  shareSessionId?: string;
  publicationAttempt?: number;
}

export interface ScreenPublicationClosed {
  peerId: string;
  producerId: string;
  shareSessionId?: string;
  replacing?: boolean;
}

export function isStaleScreenPublication(current: ScreenPublication | undefined, next: ScreenPublication): boolean {
  return !!current?.shareSessionId && current.shareSessionId === next.shareSessionId &&
    current.videoProducerId !== next.videoProducerId &&
    current.publicationAttempt !== undefined && next.publicationAttempt !== undefined &&
    next.publicationAttempt <= current.publicationAttempt;
}

export function screenPublicationMetadata(appData: Record<string, unknown> | undefined) {
  const shareSessionId = typeof appData?.shareSessionId === 'string' &&
    /^[a-z\d:_-]{1,128}$/i.test(appData.shareSessionId) ? appData.shareSessionId : undefined;
  const publicationAttempt = Number.isSafeInteger(appData?.publicationAttempt) &&
    Number(appData?.publicationAttempt) > 0 ? Number(appData?.publicationAttempt) : undefined;
  return { shareSessionId, publicationAttempt };
}

/** Known publications pair audio only with their exact capture and attempt. */
export function screenAudioMatchesPublication(current: ScreenPublication | undefined, appData: Record<string, unknown>): boolean {
  const audio = screenPublicationMetadata(appData);
  if (!current?.shareSessionId && !audio.shareSessionId) return true;
  return !!current?.shareSessionId && current.shareSessionId === audio.shareSessionId &&
    current.publicationAttempt !== undefined && current.publicationAttempt === audio.publicationAttempt;
}

interface ScreenWatchRecoveryOptions {
  isWatching: (peerId: string) => boolean;
  onReplacing: (peerId: string) => void;
  resume: (source: ScreenPublication, isCurrent: () => boolean) => Promise<boolean>;
  stop: () => void;
}

/** Retains only an existing viewer's intent within one explicit publication.
 * Legacy closes and a new share session never start another watch implicitly. */
export function createScreenWatchRecovery(options: ScreenWatchRecoveryOptions) {
  let source: ScreenPublication | null = null;
  let generation = 0;
  let replacing = false;
  let attempts = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    if (retry !== undefined) clearTimeout(retry);
    deadline = retry = undefined;
  };
  const cancel = () => {
    generation++;
    source = null;
    replacing = false;
    attempts = 0;
    clearTimers();
  };
  const stop = () => { cancel(); options.stop(); };
  const begin = (publication: ScreenPublication) => {
    cancel();
    source = publication;
  };
  const wait = () => {
    if (replacing) return;
    replacing = true;
    attempts = 0;
    options.onReplacing(source!.socketId);
    deadline = setTimeout(() => {
      if (source && options.isWatching(source.socketId)) stop();
      else cancel();
    }, 5000);
  };
  const sourceClosed = (closed: ScreenPublicationClosed): boolean => {
    if (!source || source.socketId !== closed.peerId || source.videoProducerId !== closed.producerId)
      return false;
    if (closed.replacing && source.shareSessionId && closed.shareSessionId === source.shareSessionId) {
      generation++;
      wait();
    } else stop();
    return true;
  };
  const sourceAvailable = (publication: ScreenPublication) => {
    if (!source || !options.isWatching(source.socketId) || source.socketId !== publication.socketId ||
      source.videoProducerId === publication.videoProducerId) return;
    if (!source.shareSessionId || source.shareSessionId !== publication.shareSessionId) {
      stop();
      return;
    }
    if (isStaleScreenPublication(source, publication)) return;
    wait();
    source = publication;
    const token = ++generation;
    if (retry !== undefined) clearTimeout(retry);
    const isCurrent = () => token === generation && source === publication &&
      options.isWatching(publication.socketId);
    const run = async () => {
      if (!isCurrent()) return;
      if (attempts >= 3) { stop(); return; }
      attempts++;
      let resumed = false;
      try { resumed = await options.resume(publication, isCurrent); } catch { /* bounded retry below */ }
      if (!isCurrent()) return;
      if (resumed) { replacing = false; clearTimers(); }
      else if (attempts >= 3) stop();
      else retry = setTimeout(() => { retry = undefined; void run(); }, attempts === 1 ? 250 : 750);
    };
    void run();
  };
  return { begin, cancel, sourceClosed, sourceAvailable };
}
