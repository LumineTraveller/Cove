import joinToneUrl from './assets/voice-join.wav?url';
import leaveToneUrl from './assets/voice-leave.wav?url';

export type PresenceToneAction = 'join' | 'leave';

const cues = { join: joinToneUrl, leave: leaveToneUrl };
const buffers = new WeakMap<BaseAudioContext, Partial<Record<PresenceToneAction, Promise<AudioBuffer>>>>();

/** Play the approved resource through the caller's existing output and volume. */
export async function schedulePresenceTone(
  context: BaseAudioContext,
  output: AudioNode,
  action: PresenceToneAction,
): Promise<void> {
  try {
    const isClosed = () => context.state === 'closed';
    if (isClosed()) return;
    const cache = buffers.get(context) ?? {};
    buffers.set(context, cache);
    const decoded = cache[action] ??= fetch(cues[action])
      .then(response => {
        if (!response.ok) throw new Error('Presence cue resource is unavailable');
        return response.arrayBuffer();
      })
      .then(bytes => context.decodeAudioData(bytes))
      .catch(error => { delete cache[action]; throw error; });
    const buffer = await decoded;
    // A late decode must not create sound after its owning context was closed.
    if (isClosed()) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.onended = () => source.disconnect();
    source.start();
  } catch {
    // UI feedback is optional; resource/decode failures never affect voice.
  }
}
