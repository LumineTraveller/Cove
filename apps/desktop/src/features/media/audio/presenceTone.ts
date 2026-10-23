export type PresenceToneAction = 'join' | 'leave';

/** Local UI feedback only; the caller owns the output route and AudioContext. */
export function schedulePresenceTone(
  context: BaseAudioContext,
  output: AudioNode,
  action: PresenceToneAction,
): void {
  const frequencies = action === 'join' ? [523.25, 659.25] : [493.88, 392.0];
  // A small second harmonic adds definition without the sharp upper partials
  // of a square/saw wave. The sum stays at one, with no loudness normalization.
  const wave = context.createPeriodicWave(
    new Float32Array(3),
    new Float32Array([0, 0.86, 0.14]),
    { disableNormalization: true },
  );
  const start = context.currentTime;
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + index * 0.078;
    oscillator.setPeriodicWave(wave);
    oscillator.frequency.value = frequency;
    // Exact-zero ends and a short attack avoid clicks. The lower peak and
    // shorter decay make the cue crisper without increasing its loudness.
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.11, noteStart + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.078);
    gain.gain.linearRampToValueAtTime(0, noteStart + 0.09);
    oscillator.connect(gain).connect(output);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.095);
  });
}
