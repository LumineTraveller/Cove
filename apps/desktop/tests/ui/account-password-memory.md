# Account password memory QA

Memory is opt-in and scoped by the normalized server URL and email. Only a
successful account login/register saves the password. Selecting a remembered
account reads it through the main-process IPC bridge; the server access password
still needs separate input. Cancel memory, forget one account, or clear all
remembered passwords to remove ciphertext. Ordinary login history never stores
the account password.

The main process uses Electron safeStorage. Linux basic_text/unknown backends
disable password saving; unavailable encryption keeps manual login usable.
Only the main window's main frame can access this bridge.

Run unit tests from the repository root:

```powershell
npm run test:account-auth -w cove-client
node node_modules/typescript/bin/tsc -p apps/desktop/electron/tsconfig.json
```

For the actual product renderer/preload and OS encryption check, start Vite in
`apps/desktop` with an isolated port, then run the Electron fixture:

```powershell
$env:COVE_DEV_RENDERER_PORT = '55176'
npm run dev -- --mode production
# In a second terminal, also in apps/desktop:
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:COVE_PASSWORD_QA_ARTIFACTS = 'C:\path\to\isolated\test-artifacts'
node node_modules/electron/cli.js tests/ui/account-password-memory.electron.cjs
```

The fixture uses its own userData/sessionData directory, fictional credentials
and synthetic localhost API replies. It never reads the installed product's
profile. It checks real OS encryption, account/server password separation,
successful/failed login, cancel, forget and clear. Evidence is written to
`desktop-ui.json` and `desktop-synthetic-login.png`; exit code is nonzero on
failure. Stop the isolated Vite process when finished. No installer is needed.
