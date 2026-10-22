type ScreenProducer = { appData: Record<string, unknown> };
const replacing = new WeakMap<ScreenProducer, string>();

function sessionId(producer: ScreenProducer): string | undefined {
  const value = producer.appData.shareSessionId;
  return ['screen', 'screen-audio'].includes(String(producer.appData.type)) &&
    typeof value === 'string' && /^[a-z\d:_-]{1,128}$/i.test(value) ? value : undefined;
}

/** Only the owning producer's already registered publication may be replaced. */
export function markScreenReplacement(producer: ScreenProducer, requestedSession: unknown) {
  const id = sessionId(producer);
  if (id && requestedSession === id) replacing.set(producer, id);
}

export function screenProducerClosure(producer: ScreenProducer) {
  const id = sessionId(producer);
  return id ? { shareSessionId: id, replacing: replacing.get(producer) === id } : {};
}
