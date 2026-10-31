# Personal soundpack order

Soundpack content belongs to a room. Upload, rename, normalization, deletion and
playback continue to use the existing authenticated room HTTP/Socket.IO APIs.
Sorting a sound or exchanging groups changes only the current member's local
preferences. New desktop and mobile clients never send `soundpack:reorder` and
do not subscribe to `soundpack:reordered`.

## Storage and migration

The existing groups preference stores both group membership and order, so no
additional server schema, account field or network protocol is required.
Desktop retains `cove:soundpack-groups:room:v1:<scope>`; mobile retains
`cove:soundpack-groups:v2:<scope>`. Their `{version: 1, groups}` payload is
unchanged. Scope encodes the normalized server URL (including server path),
account ID and room ID separately. Favorites retain their existing scoped keys.

An existing valid groups payload becomes the personal order as stored, without
sorting it against server rank. An installation without valid preferences seeds
its first order from the first validated room snapshot. Previously unassigned
server-wide groups/favorites are left untouched; they are never copied into a
room. This does not recover an older order already overwritten by an old client.

Later snapshots reconcile content membership only. Deleted IDs disappear from
groups and favorites; surviving sounds keep their personal relative positions.
New IDs append to the first group's end, retaining the existing first-group
placement rule. Empty groups survive. Renaming/normalizing a sound does not
change its position. The shared pure policy lives in
`packages/client-core/src/soundpackOrdering.ts`, and complete local drag results
are validated in linear time with no legacy 500-item request limit.

Preferences persist on this device for this server/account/room. They do **not**
sync between desktop, phone, browser profiles or other devices. Clearing app data
also clears the personal order. Storage failure retains the in-memory order for
the current session and displays a save notice.

## Compatibility and lifecycle

The server's legacy room reorder API and events remain available to old clients.
An old client's room reorder affects those old clients; its event cannot change
a new client's personal groups. A later old-order snapshot can still update
shared content without replacing personal rank. No existing audio files,
database rows or server `sortOrder` values are migrated or deleted.

Desktop remounts the room panel when server/account/room/socket readiness changes;
its canceled room lifetime rejects late HTTP and event work. Preference saves
also check that the panel is mounted and the preference scope still matches.
Mobile clears visible data when scope changes, waits for both preferences and a
validated room list before reconciliation, serializes AsyncStorage writes per
key, and deactivates old socket callbacks on effect cleanup. Content revisions
discard snapshots started before live content changes. Local sorting does not
invalidate an in-flight content snapshot because it does not change content.

## Focused verification

Before changes: desktop groups/room/motion 20 tests; mobile groups/controller/UI
37 tests. Updated checks include independent simultaneous mobile members,
account A/B/A and room A/B/A isolation, saved-order refresh, live additions and
deletions, legacy reorder, late HTTP/events, preference hydration, and a 751-sound
controller list. Pure policy tests additionally cover 1201 IDs and duplicate,
missing and foreign drag results.

The offline Electron soundpack fixture drives the actual desktop panel with
native mouse and keyboard events, verifies no shared reorder emission for sound
and whole-group drags, and covers cancellation, scrolling, mid-drag deletion,
account/room switches, stale snapshots and renderer restart persistence. It uses
synthetic accounts and a separate `runtime/soundpack-groups-ui/electron-data`
profile, without a live server or the user's app data.

```powershell
node node_modules/typescript/bin/tsc -p packages/client-core/tsconfig.json
node --import tsx --test packages/client-core/tests/soundpackOrdering.test.ts
# Run desktop tests from apps/desktop (its JSX configuration is required):
node --import tsx --test tests/soundpackGroups.test.ts tests/soundpackRoom.test.ts tests/soundpackMotion.test.ts
# Run mobile tests from apps/mobile:
node node_modules/jest/bin/jest.js --runInBand __tests__/useSoundboard.test.tsx __tests__/soundpackGroups.test.ts __tests__/Soundboard.test.tsx
# Run the offline desktop interaction fixture from the repository root:
node apps/desktop/tests/ui/build-soundpack-groups-fixture.cjs
& .\apps\desktop\node_modules\.bin\electron.cmd apps/desktop/tests/ui/soundpack-groups.electron.cjs
```
