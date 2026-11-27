const SEQUENCE_HEADER = 1;
const TEMPORAL_DELIMITER = 2;
const FRAME_HEADER = 3;
const FRAME = 6;
const MAX_SEQUENCE_HEADER_BYTES = 4096;
const CONFIGURATION_SEARCH_FRAMES = 32;

type EncodedFrame = Pick<RTCEncodedVideoFrame, 'data' | 'type' | 'getMetadata'>;
type SequenceHeader = { start: number; end: number; payload: number; sized: boolean };
export type Av1SequenceConfiguration = { stream: string; bytes: Uint8Array };

export type Av1KeyFrameObservation = {
  action: 'invalid-prefix' | 'configuration-only' | 'unchanged' | 'reordered' | 'repeated' | 'missing-sequence';
  inputBytes: number;
  outputBytes: number;
  obuTypes: number[];
  sequenceOffset: number | null;
  rtpTimestamp: number | null;
};

function inspectFrame(bytes: Uint8Array, obuTypes: number[]) {
  let offset = 0;
  let insertAt = 0;
  let hasPicture = false;
  let sequence: SequenceHeader | undefined;
  // Skip each picture by its declared length if the header was absent in its prefix.
  for (let index = 0; index < 16 && offset < bytes.length; index++) {
    const start = offset;
    const header = bytes[offset++];
    if ((header & 0x81) !== 0) return null;
    const type = (header >> 3) & 0x0f;
    obuTypes.push(type);
    if (header & 0x04) offset++;
    if (offset > bytes.length) return null;

    const sized = (header & 0x02) !== 0;
    let size = bytes.length - offset;
    if (sized) {
      size = 0;
      let complete = false;
      for (let part = 0; part < 8 && offset < bytes.length; part++) {
        const byte = bytes[offset++];
        size += (byte & 0x7f) * 2 ** (part * 7);
        if ((byte & 0x80) === 0) { complete = true; break; }
      }
      if (!complete || size > bytes.length - offset) return null;
    }
    const end = offset + size;
    if (type === FRAME_HEADER || type === FRAME) {
      if (!size) return null;
      hasPicture = true;
      if (sequence || !sized) return { sequence, insertAt, hasPicture };
    }
    if (type === TEMPORAL_DELIMITER) {
      if (!sized || size !== 0) return null;
      if (index === 0) insertAt = end;
      else return hasPicture ? { sequence, insertAt, hasPicture } : null;
    }
    if (type === SEQUENCE_HEADER) {
      if (!size || end - start > MAX_SEQUENCE_HEADER_BYTES) return null;
      sequence ??= { start, end, payload: offset, sized };
      if (hasPicture) return { sequence, insertAt, hasPicture };
    }
    offset = end;
  }
  // An encoder can deliver a separate configuration frame.
  return hasPicture || (offset === bytes.length && sequence) ? { sequence, insertAt, hasPicture } : null;
}

function copySequenceHeader(bytes: Uint8Array, { start, end, payload, sized }: SequenceHeader) {
  if (sized) return bytes.slice(start, end);
  // An unsized sequence-only OBU consumes its whole buffer. Prefix its payload
  // length before inserting it into a buffer that also contains a picture.
  let length = end - payload;
  const size: number[] = [];
  do {
    const part = length & 0x7f;
    length >>>= 7;
    size.push(part | (length ? 0x80 : 0));
  } while (length);
  const header = bytes.subarray(start, payload);
  const result = new Uint8Array(end - start + size.length);
  result.set(header);
  result[0] |= 0x02;
  result.set(size, header.length);
  result.set(bytes.subarray(payload, end), header.length + size.length);
  return result;
}

export function createAv1SequenceHeaderRepeater(
  initial?: Av1SequenceConfiguration,
  onConfiguration?: (configuration?: Av1SequenceConfiguration) => void,
) {
  let configuration = initial;
  let keyStream = initial?.stream;
  let searchFrames = CONFIGURATION_SEARCH_FRAMES;
  return (frame: EncodedFrame) => {
    const key = frame.type === 'key';
    // Copying encoded delta data is only necessary while looking for a separate
    // configuration at startup. Every keyframe can still carry a fresh header.
    if (!key) {
      if (frame.type !== 'delta' || configuration || searchFrames === 0) return;
      searchFrames--;
    }
    const { synchronizationSource, payloadType, width, height, rtpTimestamp } = frame.getMetadata();
    const stream = `${synchronizationSource}:${payloadType}:${width}:${height}`;
    if (key && keyStream !== stream) {
      keyStream = stream;
      searchFrames = CONFIGURATION_SEARCH_FRAMES;
    }
    if (configuration && configuration.stream !== stream) {
      configuration = undefined;
      onConfiguration?.();
    }
    const bytes = new Uint8Array(frame.data);
    const observation: Av1KeyFrameObservation = {
      action: 'invalid-prefix',
      inputBytes: bytes.length,
      outputBytes: bytes.length,
      obuTypes: [],
      sequenceOffset: null,
      rtpTimestamp: rtpTimestamp ?? null,
    };
    const inspected = inspectFrame(bytes, observation.obuTypes);
    if (!inspected) return key ? observation : undefined;
    const { sequence, insertAt, hasPicture } = inspected;
    if (sequence) {
      observation.sequenceOffset = sequence.start;
      observation.action = key && hasPicture ? 'unchanged' : 'configuration-only';
      configuration = { stream, bytes: copySequenceHeader(bytes, sequence) };
      onConfiguration?.(configuration);
      if (key && hasPicture && sequence.start > insertAt) {
        // WebRTC sets the coded-sequence bit only if the sequence header is the
        // first OBU after filtering the temporal delimiter. Preserve the
        // metadata and picture while putting the header before them.
        const header = configuration.bytes;
        const result = new Uint8Array(bytes.length - (sequence.end - sequence.start) + header.length);
        result.set(bytes.subarray(0, insertAt));
        result.set(header, insertAt);
        result.set(bytes.subarray(insertAt, sequence.start), insertAt + header.length);
        result.set(bytes.subarray(sequence.end), sequence.start + header.length);
        frame.data = result.buffer;
        observation.action = 'reordered';
        observation.outputBytes = result.length;
      }
      return observation;
    }
    if (!key) return;
    observation.action = 'missing-sequence';
    if (!configuration || !hasPicture) return observation;
    const result = new Uint8Array(bytes.length + configuration.bytes.length);
    result.set(bytes.subarray(0, insertAt));
    result.set(configuration.bytes, insertAt);
    result.set(bytes.subarray(insertAt), insertAt + configuration.bytes.length);
    frame.data = result.buffer;
    observation.action = 'repeated';
    observation.outputBytes = result.length;
    return observation;
  };
}

export function isAv1StartupKeyFrame({ action }: Av1KeyFrameObservation) {
  return action === 'unchanged' || action === 'reordered' || action === 'repeated';
}
