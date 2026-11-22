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

/** Use the resource profile qualified on this GPU, driver and CPU. */
export function supportsPackedScreenCapture(gpuInfo: unknown, cpuModel: string): boolean {
  if (!gpuInfo || typeof gpuInfo !== 'object' || !/^AMD Ryzen 9 7945HX\b/i.test(cpuModel)) return false;
  const devices = (gpuInfo as { gpuDevice?: Array<{ vendorId: number; deviceId: number; driverVersion: string }> }).gpuDevice;
  if (!Array.isArray(devices)) return false;
  const hardware = devices.filter(device => device?.vendorId !== 0x1414);
  return hardware.length > 0 && hardware.every(device => device?.vendorId === 0x10de &&
    device.deviceId === 0x28e0 && device.driverVersion === '32.0.15.6094');
}
