/** Hold the updater's quit hook before the asynchronous OS launch can begin. */
export async function handoffRepairInstaller(file: string, options: {
  suspendAutoInstall: () => () => void;
  openPath: (file: string) => Promise<string>;
}): Promise<boolean> {
  const restore = options.suspendAutoInstall();
  try {
    if (await options.openPath(file)) {
      restore();
      return false;
    }
    // The OS accepted the repair installer. Keep the other installer suppressed
    // even if the window closes before the caller can issue its own app.quit().
    return true;
  } catch {
    restore();
    return false;
  }
}
