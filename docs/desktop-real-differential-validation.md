# Real Windows differential update validation

The frozen updater from commit `038ae8101c89b67e7406a512519deed223277684`
successfully reconstructed the official **2.1.0 → 2.1.1** installer through both
the Cove mirror and GitHub on 2026-10-23. Each source passed its first attempt.
This closes the earlier public-network reconstruction gap left by the two failed
Node/TLS trials; those earlier failures remain preserved in their original logs.

## Runtime and source provenance

The verification used **Electron 44.0.0 / Chromium 152.0.7977.54 / Node 24.18.1**,
the actual `ElectronHttpExecutor` backed by `electron.net.request()`, and the real
`electron-updater` **6.8.9**. This was not the Node transport adapter used by the
synthetic tests.

An `AppAdapter` simulated installed version 2.1.0 inside an independent cache.
No application was installed. The main process opened no window and used its own
userData/sessionData; automatic installer execution was disabled and the adapter's
quit/relaunch hooks refused invocation.

The tool compared five updater TypeScript files against `git show 038ae81`,
normalizing CRLF/LF only for that comparison. It compiled the protected updater's
dependency closure into the run's `compiled/` directory with the Electron
project's target/module/strict settings. The worker loaded those files.
`provenance.json` records the actual source and compiled JavaScript SHA256 values,
compiler settings, output isolation checks and this frozen harness hash:

```text
9033c64549cbcb83cbd9ac05e62b3f54b0859bf8917a6bed615313307d4c35fc
```

Existing delivered bundles, source versions, updater dependencies and user caches
were not modified. The original old installer was verified against the saved
official GitHub SHA256 digest. The existing new installer matched its published
`latest.yml` SHA512/size and `SHA256SUMS`. No complete installer was fetched from
the public network for this validation.

## Public-network reconstruction

| Source | Attempt | Valid single Ranges | Differential body | All HTTP response bodies | Ready events |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cove HTTPS mirror | 1 | 12 | 4,543,361 bytes | 4,769,968 bytes | 1 |
| GitHub HTTPS release | 1 | 12 | 4,543,361 bytes | 4,769,968 bytes | 1 |

The differential body was **4.25975%** of the 106,658,038-byte installer.
Including blockmaps and metadata, the observed HTTP response bodies were
**4.47221%**. These values exclude transport/TLS/header overhead. GitHub recorded
five redirects across the complete update flow. Every actual installer Range
response had matching 206 status, Content-Range, Content-Length and body length,
without content encoding. The records use response byte counters, not URL-suffix
inference for redirected blockmap requests.

Both reconstructed files had the exact published size and hashes:

```text
size:   106658038
SHA256: 84b9439e14764f935a51d9e1931f482d9fff50e2fcc88222a51f8218c138a263
SHA512: yTIg8IiXpIQ+/FcOI0mF5VkCKfZ3/WCXKIgYxpk7lZ9x4xRdghRk95+vWVRks2dwWagPNrvcFFwjCgXb2xccnA==
```

The actual protected updater completed its baseline preflight, native differential
reconstruction and final target verification before emitting readiness. Each run
also asserted that its root old EXE, installed-version identity record and old
blockmap remained correctly paired. The copied baseline was not promoted merely
because the new package downloaded.

## Real-asset fallback checks

The same actual Electron executor and native integrity path were exercised over
loopback HTTP using the existing official new EXE as a read-only stream source.
This tested complete transfers without downloading another public 106 MB copy.

| Isolated baseline / response | Preflight outcome | Range / blockmap requests | Result |
| --- | --- | --- | --- |
| Missing old EXE | `ENOENT` → full | 0 / 0 | Exact official full target, ready once |
| Same-size old EXE with one byte changed | `COVE_BASELINE_MISMATCH` → full | 0 / 0 | Exact official full target, ready once |
| Corrupt old EXE; full response's first byte changed in a streaming transform | `COVE_BASELINE_MISMATCH` → full | 0 / 0 | SHA512 mismatch rejected, zero ready events |

Thus an unusable baseline was identified before requesting differential bytes,
and full fallback retained integrity verification. The corrupt-full fixture
changed an in-memory response chunk, not either original asset.

## Evidence and bounded execution

The complete run finished in approximately 31 seconds and exited with code 0:

- `runtime/validation-after-038ae81/desktop-differential/electron-real-assets-1/result.json`
- `runtime/validation-after-038ae81/desktop-differential/electron-real-assets-1/provenance.json`
- `runtime/validation-after-038ae81/desktop-differential/electron-real-assets-1/launch.json`
- `runtime/validation-after-038ae81/desktop-differential/electron-real-assets-1/exit.json`
- `runtime/validation-after-038ae81/desktop-differential/guard-check-result.json`

The public-network limit was two attempts per source, 150 seconds each; no retry
was needed. Metadata reads were limited to 15 seconds, each fallback scenario to
60 seconds, and the worker to 690 seconds overall. Waiting and hashing both
checked cancellation before a scenario could pass. A failed public differential
would cancel before a duplicate public full transfer. TLS verification, existing
proxy behavior and OS/network policies were retained.

The CLI rejects the allowed root itself (including case variants), cross-drive
or outside paths, nonempty output reuse, and redirected ancestors. Six lightweight
guard cases passed; the junction target remained untouched. A worker checks the
parent-created owner marker and actual directory chain before using its output.
The tool never clears an existing result directory.

The reusable entrypoint is `tooling/verify-desktop-differential-real.cjs`. Its
`--phase` choices are `probe`, `remote-cloud`, `remote-github`, `fallback`, and
`all`; `--output` must name a fresh dedicated child of the validation runtime.
`--new-assets` may locate the existing official bundle when it is no longer in
the default Temp directory. No further network rerun is required for a prose or
link-only change to this document.

This verifies real published bytes, the protected updater and both download
paths in an isolated process. It does not exercise a user's installed application
or execute the final Windows installer. The isolated `app-update.yml` did not
configure `publisherName`, so Authenticode validation was not exercised. It does
not guarantee future network availability or protection from unrelated external
cache modifications. The particular actor that removed the old installer in the
latest ENOENT incident and the cause of the historical reconstruction checksum
failure remain unknown; successful current reconstruction does not establish
those causes.
