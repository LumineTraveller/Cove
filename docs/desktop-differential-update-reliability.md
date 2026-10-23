# Desktop differential update reliability

The later [real published-asset verification](desktop-real-differential-validation.md)
passed through the actual Electron HTTP executor on both HTTPS sources. It records
the isolated-process scope separately from these synthetic tests and the earlier
unsuccessful Node/TLS trials.

This change applies to the Windows NSIS updater. It does not alter a release
version, install an application, clear the running user's cache, or change server
Range/TLS settings. Both configured HTTPS mirrors keep single-Range differential
downloads enabled. macOS/Linux retain the existing updater.

## What was established

The 2.1.0 → 2.1.1 log calculated a small differential transfer and then failed to
open the old cache `installer.exe` with ENOENT. The actor that removed that
particular baseline is unknown. Historical Gitee cleanup did delete the installed
EXE and blockmap; two older log sequences establish that specific causal path.
Legacy cleanup now removes only the matching verified **pending** package and
its metadata after its version is installed. Root `installer.exe` and
`current.blockmap` are retained for the next update.

`electron-updater` 6.8.9 also emits its downloaded event before it copies the
pending blockmap to the root. NSIS copies the installer EXE to the root later,
during installation. That can leave a new blockmap paired with an old EXE and
expose the install action before download tail work finishes.

## Integration and lifecycle

`StableNsisUpdater` subclasses the shipped `NsisUpdater`. Its protected
`differentialDownloadInstaller` hook verifies the baseline and then calls the
original implementation. The native planner, HTTP executor, differential target
SHA512 verification, full-download SHA512 verification and signature policy are
preserved. No dependency files or global prototypes are patched.

Before differential planning, the module checks a regular independent baseline
file, the installed application version, expected installer size, and a streaming
SHA512 of the complete old EXE. It resolves identity in this order:

1. An installed-version `cove-baseline.json` record.
2. A matching `cove-next-baseline.json` left by a previously verified download.
3. Legacy `pending/update-info.json`, only if the exact installer filename matches
   the current installed version and its SHA512 matches the root EXE.
4. Recovery from that installed version's `latest.yml` on the exact official
   GitHub/Cove versioned path. This is used only when no local identity applies.

No usable identity, size/hash mismatch, unsafe path, cancellation or changing EXE
is treated as a verified differential baseline. An unverified legacy root map is
fetched again from the installed version's blockmap URL, rather than inferred
from existence or size. Verified maps are bound to the recorded identity with a
local SHA512, so subsequent checks avoid these recovery requests. A missing or
changed map can be fetched again after the EXE identity passes.

Recovery has a 20-second preflight budget, 10 seconds per metadata request,
parent-token cancellation, bounded parsed metadata/map sizes, and cancellation
checks during hashing. Missing official versioned recovery data causes an
explicit complete-installer fallback. A custom mirror can use an existing local
identity; it cannot bootstrap a new identity through its own `latest.yml`.

On successful native download/cache validation, the module stages the new map as
`cove-next.blockmap` and writes the next identity before exposing readiness. It
removes the native **pending** map path before the library can copy it over the
installed map. The installed EXE/map pair remains intact. A future process only
promotes the next map after its installed version and root EXE SHA512 both match
the staged record. Starting an installer is not considered proof of installation.

The public ready event waits for the original download promise tail. The
synchronous install hook refuses an installer handoff during finalization,
including auto-install-on-quit. A cache-scoped exclusive lock covers the whole
native download, pending-cache validation/cleanup and identity staging; a separate
short lock protects legacy cleanup. Every success/failure/cancellation path
releases its lock. Windows uses a local named pipe keyed by the normalized cache
path; Linux tests use an abstract socket. They accept no commands or payloads and
destroy connections immediately. The kernel releases ownership even after a
process crash, so no PID-file reclamation or stat/unlink race is involved. Listen
and close are bounded, acquisition can be cancelled, and repeated release cannot
release a newer owner's lock. Other platforms conservatively fail closed on a
leftover Unix-socket path; they do not attempt unsafe automatic reclamation.

Readiness also binds a synchronous file-stat snapshot. Installation refuses a
missing/changed installer before handing it to the OS. Failed finalization
clears this readiness lease, so an already registered automatic-quit handler
cannot install an EXE whose final validation failed.

## Reporting and limits

The renderer receives differential/full/cached mode and a stable fallback reason
code. It resets transfer metrics when a differential attempt becomes a full
download and retains that reason through verification and readiness. A completed
full fallback is not presented as a successful differential transfer. New
diagnostic summaries are restricted to one line and 512 characters, with URL
credentials/query strings, user paths and token-like values removed; raw native
stacks are not sent to the mode UI.

These checks coordinate processes using this module. NSIS, older Cove processes,
security software and external file operations do not honor its lock. They can
still change or remove a file after preflight; the native final target digest and
safe full fallback remain essential. A local identity record is an integrity and
lifecycle record, not a cryptographic defense against a hostile local account.
Missing baselines, unavailable old release metadata and network/TLS failures can
still require a full download. This change does not promise fault-free networks.

## Verification and dependency upgrades

Run `npm run test:updater -w cove-client`. The new tests are also discovered by
`node tooling/ci-regression.cjs desktop`. All new writable fixtures use their own
temporary directory; the native HTTP integration uses loopback only and never
launches an installer. A child-process fixture holds an IPC lock, excludes a
competitor and exits abruptly to verify kernel cleanup. A same-instance cached
EXE is rehashed before readiness, because the library's cache fast path checks
only existence. A corrupt pending EXE is precisely invalidated for safe retry;
the installed root baseline is retained. An invalid optional next blockmap does
not block a fully verified complete installer from becoming ready.

Tests use the real 6.8.9 NSIS execution and differential planner. Electron's real
full-download/DigestTransform implementation is retained while request creation
is adapted to Node loopback for tests. The redirect case adapts Node's 302 response
to Electron's redirect/followRedirect event contract; it is not a live Electron
or public-Internet transport certification. Tests cover changed-byte reconstruction,
redirect Range preservation, ignored/corrupt/truncated ranges and HTTP 416,
visible full fallback, invalid-full rejection, lock/cancel paths and delayed
readiness. Helper tests cover baseline identity/missing/hash/change and map
promotion. The dependency contract test intentionally asserts version 6.8.9.

When upgrading `electron-updater`, review its protected hooks and these actual
runtime fields omitted from its declarations: `httpExecutor` and `configOnDisk`.
Recheck `AppUpdater.executeDownload`'s event/map-copy ordering,
`BaseUpdater.executeDownload`'s quit-handler registration, `NsisUpdater.doInstall`
and the NSIS installer baseline-copy behavior. Keep the native integrity checks.

Prior live 2.1.0 → 2.1.1 reconstruction attempts in
`runtime/release-2.1.1-0.8.3/differential-reconstruction` failed during TLS before
the final digest and do not count as successful public-network differential
acceptance. This patch's isolated native tests complement that evidence; they do
not replace a future packaged update exercise on a separate test profile.
