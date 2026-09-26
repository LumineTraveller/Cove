import { NativeModules } from 'react-native';

export interface AudioDeviceOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface AudioDeviceList {
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
  inputId: string;
  outputId: string;
}

interface CoveNativeAudioModule {
  listAudioDevices(): Promise<AudioDeviceList>;
  setAudioInputDevice(deviceId: string): Promise<string>;
  setAudioOutputDevice(deviceId: string): Promise<string>;
  setSpeakerphoneEnabled(enabled: boolean): void;
}

const CoveNative = NativeModules.CoveNative as CoveNativeAudioModule | undefined;

export const DEFAULT_OUTPUT_ID = 'out-speaker';
export const EARPIECE_OUTPUT_ID = 'out-earpiece';
export const BLUETOOTH_OUTPUT_ID = 'out-bluetooth';
export const DEFAULT_INPUT_ID = 'default';

export function isAudioDeviceBridgeAvailable(): boolean {
  return !!CoveNative?.listAudioDevices;
}

export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (!CoveNative?.listAudioDevices) {
    return { inputs: [], outputs: [], inputId: DEFAULT_INPUT_ID, outputId: DEFAULT_OUTPUT_ID };
  }
  const result = await CoveNative.listAudioDevices();
  return {
    inputs: result.inputs ?? [],
    outputs: result.outputs ?? [],
    inputId: result.inputId || DEFAULT_INPUT_ID,
    outputId: result.outputId || DEFAULT_OUTPUT_ID,
  };
}

export async function setAudioInputDevice(deviceId: string): Promise<string> {
  if (!CoveNative?.setAudioInputDevice) return DEFAULT_INPUT_ID;
  return CoveNative.setAudioInputDevice(deviceId);
}

export async function setAudioOutputDevice(deviceId: string): Promise<string> {
  if (!CoveNative?.setAudioOutputDevice) return DEFAULT_OUTPUT_ID;
  return CoveNative.setAudioOutputDevice(deviceId);
}

export function outputDeviceLabel(id: string, outputs: AudioDeviceOption[]): string {
  return outputs.find((device) => device.id === id)?.label ?? '扬声器';
}

export function inputDeviceLabel(id: string, inputs: AudioDeviceOption[]): string {
  return inputs.find((device) => device.id === id)?.label ?? '系统默认麦克风';
}
