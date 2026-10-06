/** A point in screen coordinates, normalized to the shared video bounds. */
export interface AnnotationPoint {
  x: number;
  y: number;
}

export type AnnotationTool = 'pen' | 'eraser';
export type AnnotationPermission = 'everyone' | 'request' | 'sharer';

/** A stroke segment as stored and broadcast by the server. */
export interface AnnotationStroke {
  id: string;
  /** Assigned by the server; clients must not submit this value. */
  authorSocketId: string;
  tool: AnnotationTool;
  color: string;
  /** Normalized line width in the range 0.0005..0.08. */
  width: number;
  points: AnnotationPoint[];
}

/** Client supplied stroke data. The server assigns authorSocketId. */
export type AnnotationStrokeInput = Omit<AnnotationStroke, 'authorSocketId'>;

export interface AnnotationRequest {
  socketId: string;
  username: string;
}

/** Identifies one particular screen producer generation. */
export interface AnnotationTarget {
  roomId: string;
  sharerSocketId: string;
  sessionId: string;
}

/** Target used to fetch the first snapshot before the producer id is known. */
export type AnnotationGetTarget = Omit<AnnotationTarget, 'sessionId'> & {
  sessionId?: string;
};

export interface AnnotationState {
  roomId: string;
  sharerSocketId: string;
  /** The current screen producer id, which changes for every sharing generation. */
  sessionId: string;
  /** Increments for every state mutation and accepted stroke chunk. */
  revision: number;
  enabled: boolean;
  permission: AnnotationPermission;
  remoteControlAllowed: boolean;
  strokes: AnnotationStroke[];
  /** Socket ids granted permission to draw while permission is `request`. */
  grants: string[];
  requests: AnnotationRequest[];
}

export interface AnnotationError {
  code:
    | 'invalid_payload'
    | 'invalid_target'
    | 'forbidden'
    | 'not_found'
    | 'disabled'
    | 'rate_limited'
    | 'limit_reached';
  message: string;
}

/** Common callback payload for annotation socket events. */
export interface AnnotationAck {
  ok: boolean;
  state?: AnnotationState;
  revision?: number;
  error?: AnnotationError;
}

export interface AnnotationConfigurePayload {
  target: AnnotationTarget;
  enabled?: boolean;
  permission?: AnnotationPermission;
  remoteControlAllowed?: boolean;
}

export interface AnnotationRespondPayload {
  target: AnnotationTarget;
  requesterSocketId: string;
  accepted: boolean;
}

export interface AnnotationDrawPayload {
  target: AnnotationTarget;
  stroke: AnnotationStrokeInput;
}

export interface AnnotationLaserPayload {
  target: AnnotationTarget;
  point: AnnotationPoint | null;
}

/** Incremental event; chunks sharing a stroke id append to the same stroke. */
export interface AnnotationStrokeEvent {
  sessionId: string;
  revision: number;
  stroke: AnnotationStroke;
}

/** Volatile cursor event. Laser positions are never part of AnnotationState. */
export interface AnnotationLaserEvent {
  sessionId: string;
  authorSocketId: string;
  point: AnnotationPoint | null;
}
