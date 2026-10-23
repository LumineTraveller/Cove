# Desktop voice presence cues

The desktop join/leave cues are synthesized by
`apps/desktop/src/features/media/audio/presenceTone.ts`, called from the existing
`useAudioMeters` output route. The join cue rises and the leave cue falls, using
the original note frequencies. A small second harmonic and a shorter envelope
add definition; neither peak gain nor output volume is increased. Each cue ends
in exact silence by 168 ms, with its oscillator stops complete by 173 ms.

The caller still owns the shared AudioContext, selected output device and master
gain. Finished notes disconnect only their own oscillators/gains. The change
does not alter when voice events play cues, microphone capture, media/session
recovery, or context teardown.

Android uses a separate native `ToneGenerator` in `CoveNativeModule.kt`; this
desktop adjustment does not change the mobile cues.

Run the silent Chromium rendering check from the repository:

```sh
npm run test:presence-tones -w cove-client
```

The test requires the project's existing desktop Electron installation, opens no
devices, produces no audible output, and blocks network requests. It renders the
production scheduling function through real OfflineAudioContext at 16, 44.1 and
48 kHz. It checks sample finiteness, peak/energy against the previous cue,
duration, silent edges/tail, original rising/falling pitches, restrained harmonic
content, proportional master volume, mute, and note-node disconnection.

Output under `runtime/presence-tones/`:

- `join.wav` and `leave.wav`: actual production synthesis at 48 kHz, PCM16, with
  no normalization or extra gain. Each preview includes a short silent tail.
- `before-after.wav`: old join, new join, old leave, new leave, separated by
  silence, at the same output gain.
- `result.json`: objective rendering results. These do not establish subjective
  comfort or perceived loudness on every headset/speaker; audition the previews
  and the running app to assess those qualities.

Rollback is limited to the desktop cue module and its `useAudioMeters` call;
no server update, protocol migration or user-data change is involved.
