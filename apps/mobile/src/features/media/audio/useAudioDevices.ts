import { useCallback } from 'react';

import {
  DEFAULT_OUTPUT_ID,
  listAudioDevices,
  setAudioInputDevice,
  setAudioOutputDevice,
  type AudioDeviceList,
  type AudioDeviceOption,
} from './audioDevices';

export interface UseAudioDevicesDependencies {
  readonly setAudioInputs: import('react').Dispatch<
    import('react').SetStateAction<AudioDeviceOption[]>
  >;
  readonly setAudioOutputs: import('react').Dispatch<
    import('react').SetStateAction<AudioDeviceOption[]>
  >;
  readonly audioInputIdRef: import('react').RefObject<string>;
  readonly audioOutputIdRef: import('react').RefObject<string>;
  readonly setSelectedAudioInputId: import('react').Dispatch<
    import('react').SetStateAction<string>
  >;
  readonly setSelectedAudioOutputId: import('react').Dispatch<
    import('react').SetStateAction<string>
  >;
  readonly setAudioDeviceError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly audioDeviceBusyRef: import('react').RefObject<boolean>;
  readonly setAudioDeviceSwitching: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
}

export function useAudioDevices(deps: UseAudioDevicesDependencies) {
  const {
    setAudioInputs,
    setAudioOutputs,
    audioInputIdRef,
    audioOutputIdRef,
    setSelectedAudioInputId,
    setSelectedAudioOutputId,
    setAudioDeviceError,
    audioDeviceBusyRef,
    setAudioDeviceSwitching,
  } = deps;

  const refreshAudioDevices = useCallback(async () => {
    try {
      const list: AudioDeviceList = await listAudioDevices();
      setAudioInputs(list.inputs);
      setAudioOutputs(list.outputs);
      audioInputIdRef.current = list.inputId || 'default';
      audioOutputIdRef.current = list.outputId || DEFAULT_OUTPUT_ID;
      setSelectedAudioInputId(audioInputIdRef.current);
      setSelectedAudioOutputId(audioOutputIdRef.current);
      setAudioDeviceError(null);
      return list;
    } catch (error) {
      setAudioDeviceError(
        `读取音频设备失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }, [
    audioInputIdRef,
    audioOutputIdRef,
    setAudioDeviceError,
    setAudioInputs,
    setAudioOutputs,
    setSelectedAudioInputId,
    setSelectedAudioOutputId,
  ]);

  const selectAudioInput = useCallback(
    async (deviceId: string) => {
      if (
        audioDeviceBusyRef.current ||
        !deviceId ||
        deviceId === audioInputIdRef.current
      )
        return;
      audioDeviceBusyRef.current = true;
      setAudioDeviceSwitching(true);
      setAudioDeviceError(null);
      const previous = audioInputIdRef.current;
      try {
        const applied = await setAudioInputDevice(deviceId);
        audioInputIdRef.current = applied || deviceId;
        setSelectedAudioInputId(audioInputIdRef.current);
      } catch (error) {
        audioInputIdRef.current = previous;
        setSelectedAudioInputId(previous);
        setAudioDeviceError(
          `切换麦克风失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        audioDeviceBusyRef.current = false;
        setAudioDeviceSwitching(false);
      }
    },
    [
      audioDeviceBusyRef,
      audioInputIdRef,
      setAudioDeviceError,
      setAudioDeviceSwitching,
      setSelectedAudioInputId,
    ],
  );

  const selectAudioOutput = useCallback(
    async (deviceId: string) => {
      if (
        audioDeviceBusyRef.current ||
        !deviceId ||
        deviceId === audioOutputIdRef.current
      )
        return;
      audioDeviceBusyRef.current = true;
      setAudioDeviceSwitching(true);
      setAudioDeviceError(null);
      const previous = audioOutputIdRef.current;
      try {
        const applied = await setAudioOutputDevice(deviceId);
        audioOutputIdRef.current = applied || deviceId;
        setSelectedAudioOutputId(audioOutputIdRef.current);
      } catch (error) {
        audioOutputIdRef.current = previous;
        setSelectedAudioOutputId(previous);
        setAudioDeviceError(
          `切换输出设备失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        audioDeviceBusyRef.current = false;
        setAudioDeviceSwitching(false);
      }
    },
    [
      audioDeviceBusyRef,
      audioOutputIdRef,
      setAudioDeviceError,
      setAudioDeviceSwitching,
      setSelectedAudioOutputId,
    ],
  );
  return { refreshAudioDevices, selectAudioInput, selectAudioOutput };
}
