interface NativeScreenCapturePolicyOptions {
  platform: string;
  arch: string;
  electronVersion: string | undefined;
  isPackaged: boolean;
  buildFlavor: string | undefined;
  optIn: string | undefined;
  disable: string | undefined;
}

/** Release the qualified backend without changing development or lab defaults. */
export function nativeScreenCaptureEnabled(options: NativeScreenCapturePolicyOptions): boolean {
  if (options.platform !== 'win32' || options.arch !== 'x64' || options.disable === '1') return false;
  const qualifiedRelease = options.isPackaged && options.buildFlavor === undefined &&
    options.electronVersion === '44.0.0';
  return qualifiedRelease || options.buildFlavor === 'native-capture-lab' || options.optIn === '1';
}
