import { type Socket } from 'socket.io';

import {
  type AnnotationAck,
  type AnnotationConfigurePayload,
  type AnnotationDrawPayload,
  type AnnotationGetTarget,
  type AnnotationLaserPayload,
  type AnnotationRespondPayload,
  type AnnotationTarget,
} from '@cove/contracts';

import { type createAnnotationService } from './annotationService';

export interface RegisterAnnotationSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly annotations: ReturnType<typeof createAnnotationService>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callbackFrom(args: unknown[]): ((ack: AnnotationAck) => void) | undefined {
  const callback = args.find((argument) => typeof argument === 'function');
  return callback as ((ack: AnnotationAck) => void) | undefined;
}

function payloadFrom(args: unknown[]) {
  return args.find((argument) => typeof argument !== 'function');
}

export function registerAnnotationSocketHandlers(
  deps: RegisterAnnotationSocketHandlersDependencies,
) {
  function on(
    event: string,
    operation: (payload: unknown) => AnnotationAck,
  ) {
    deps.socket.on(event, (...args: unknown[]) => {
      const callback = callbackFrom(args);
      try {
        const ack = operation(payloadFrom(args));
        callback?.(ack);
      } catch {
        // Invalid or stale client packets should receive an error instead of
        // escaping the event handler or disconnecting the socket.
        callback?.({
          ok: false,
          error: { code: 'invalid_payload', message: '批注请求无效' },
        });
      }
    });
  }

  on('annotation:get', (payload) => {
    const target = isRecord(payload) ? payload.target : undefined;
    return deps.annotations.get(target as AnnotationGetTarget, deps.socket.id);
  });

  on('annotation:configure', (payload) =>
    deps.annotations.configure(
      payload as AnnotationConfigurePayload,
      deps.socket.id,
    ).ack,
  );

  on('annotation:request', (payload) => {
    const target = isRecord(payload) ? payload.target : undefined;
    return deps.annotations.request(target as AnnotationTarget, deps.socket.id).ack;
  });

  on('annotation:respond', (payload) =>
    deps.annotations.respond(
      payload as AnnotationRespondPayload,
      deps.socket.id,
    ).ack,
  );

  on('annotation:draw', (payload) =>
    deps.annotations.draw(
      payload as AnnotationDrawPayload,
      deps.socket.id,
    ).ack,
  );

  on('annotation:laser', (payload) => {
    const record = isRecord(payload) ? payload : {};
    return deps.annotations.laser(
      record.target as AnnotationTarget,
      record.point,
      deps.socket.id,
    ).ack;
  });

  on('annotation:clear', (payload) => {
    const target = isRecord(payload) ? payload.target : undefined;
    return deps.annotations.clear(target as AnnotationTarget, deps.socket.id).ack;
  });

  return {};
}
