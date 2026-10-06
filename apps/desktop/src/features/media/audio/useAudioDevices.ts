import { useEffect, useCallback } from 'react';

import {
  applyAudioContextOutput,
  applyAudioElementOutput,
  AUDIO_INPUT_DEVICE_KEY,
  AUDIO_OUTPUT_DEVICE_KEY,
  AudioDeviceOption,
  DEFAULT_AUDIO_DEVICE_ID,
  saveAudioDeviceId,
  toAudioDeviceOptions,
} from './audioDevices';

export interface useAudioDevicesDependencies {
  readonly setAudioDeviceError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly setAudioDevicesRefreshing: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly rawAudioRef: import('react').MutableRefObject<MediaStream | null>;
  readonly setAudioInputDevices: import('react').Dispatch<
    import('react').SetStateAction<AudioDeviceOption[]>
  >;
  readonly setAudioOutputDevices: import('react').Dispatch<
    import('react').SetStateAction<AudioDeviceOption[]>
  >;
  readonly selectedAudioInputRef: import('react').MutableRefObject<string>;
  readonly setSelectedAudioInputId: import('react').Dispatch<
    import('react').SetStateAction<string>
  >;
  readonly selectedAudioOutputRef: import('react').MutableRefObject<string>;
  readonly setSelectedAudioOutputId: import('react').Dispatch<
    import('react').SetStateAction<string>
  >;
  readonly audioEls: import('react').MutableRefObject<Map<string, HTMLAudioElement>>;
  readonly audioCtxRef: import('react').MutableRefObject<AudioContext | null>;
}

export function useAudioDevices(deps: useAudioDevicesDependencies) {
  const refreshAudioDevices = useCallback(async (requestPermission = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      deps.setAudioDeviceError('当前环境无法读取音频设备。');
      return;
    }
    deps.setAudioDevicesRefreshing(true);
    deps.setAudioDeviceError(null);
    let permissionStream: MediaStream | null = null;
    try {
      if (requestPermission && !deps.rawAudioRef.current) {
        permissionStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputDevices = toAudioDeviceOptions(devices, 'audioinput').filter(
        (device) => device.deviceId !== 'communications',
      );
      deps.setAudioInputDevices(inputDevices);
      deps.setAudioOutputDevices(toAudioDeviceOptions(devices, 'audiooutput'));
      // 单麦克风机器使用 Windows 默认采集端点。部分 Realtek 驱动在通过
      // Chromium 的实体 deviceId 精确打开时会返回 live 音轨，但样本几乎
      // 全为零；旧版正常工作的路径使用的正是系统默认端点。
      if (
        inputDevices.length === 1 &&
        deps.selectedAudioInputRef.current === inputDevices[0].deviceId
      ) {
        deps.selectedAudioInputRef.current = DEFAULT_AUDIO_DEVICE_ID;
        deps.setSelectedAudioInputId(DEFAULT_AUDIO_DEVICE_ID);
        saveAudioDeviceId(AUDIO_INPUT_DEVICE_KEY, DEFAULT_AUDIO_DEVICE_ID);
      }
    } catch (error) {
      deps.setAudioDeviceError(error instanceof Error ? error.message : '读取音频设备失败。');
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
      deps.setAudioDevicesRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshAudioDevices(false);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => {
      refreshAudioDevices(false);
    };
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshAudioDevices]);

  const selectAudioOutput = useCallback(async (deviceId: string) => {
    const nextDeviceId = deviceId || DEFAULT_AUDIO_DEVICE_ID;
    deps.selectedAudioOutputRef.current = nextDeviceId;
    deps.setSelectedAudioOutputId(nextDeviceId);
    saveAudioDeviceId(AUDIO_OUTPUT_DEVICE_KEY, nextDeviceId);
    deps.setAudioDeviceError(null);

    const changes: Promise<boolean>[] = [];
    deps.audioEls.current.forEach((element) => {
      changes.push(applyAudioElementOutput(element, nextDeviceId));
    });
    if (deps.audioCtxRef.current)
      changes.push(applyAudioContextOutput(deps.audioCtxRef.current, nextDeviceId));
    const results = await Promise.allSettled(changes);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      const reason = rejected.reason;
      deps.setAudioDeviceError(
        `切换扬声器失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }, []);
  return { refreshAudioDevices, selectAudioOutput };
}
