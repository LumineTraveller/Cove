import { useCallback, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';

import {
  applyAudioElementOutput,
  createRemoteAudioOutput,
  isMemberVoiceAudio,
} from '../audio/audioDevices';

import {
  Transport,
  Consumer,
  RtpCapabilities,
  emitAsync,
  RemoteScreen,
} from '../desktopMediaSupport';
import { AudioPlayoutPolicy, readAudioPlayoutMode } from './audioPlayoutPolicy';

export interface useMediaTransportsDependencies {
  readonly deviceRef: import('react').MutableRefObject<Device | null>;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly recvTransport: import('react').MutableRefObject<Transport | null>;
  readonly mediaGeneration: import('react').MutableRefObject<number>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly checkTransport: (key: string, state: string) => void;
  readonly consumerByProducer: import('react').MutableRefObject<Map<string, string>>;
  readonly pendingProducers: import('react').MutableRefObject<Set<string>>;
  readonly consumers: import('react').MutableRefObject<
    Map<
      string,
      {
        consumer: Consumer;
        socketId: string;
        kind: string;
        producerId: string;
        sourceType?: string;
      }
    >
  >;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly removeRemoteApplicationAudio: (socketId: string, producerId?: string) => void;
  readonly remoteAudioOutputs: import('react').MutableRefObject<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        gain: GainNode;
        setVolume(value: number): void;
        resume(): Promise<void>;
        close(): void;
      }
    >
  >;
  readonly setScreenReceiveHasAudio: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly ensureAudioCtx: () => AudioContext;
  readonly screenReceiveVolumeRef: import('react').MutableRefObject<number>;
  readonly masterOutputGain: import('react').MutableRefObject<GainNode | null>;
  readonly memberVolumesRef: import('react').MutableRefObject<Record<string, number>>;
  readonly applicationAudioReceiveVolumesRef: import('react').MutableRefObject<
    Record<string, number>
  >;
  readonly audioEls: import('react').MutableRefObject<Map<string, HTMLAudioElement>>;
  readonly selectedAudioOutputRef: import('react').MutableRefObject<string>;
  readonly detachAnalyser: (key: string) => void;
  readonly attachAnalyser: (
    key: string,
    stream: MediaStream,
    socketId: string,
    type?: 'voice' | 'application',
    playbackGain?: () => number,
  ) => void;
  readonly audioCtxRef: import('react').MutableRefObject<AudioContext | null>;
  readonly masterOutputVolumeRef: import('react').MutableRefObject<number>;
  readonly startMeters: () => void;
  readonly screenStreams: import('react').MutableRefObject<Map<string, MediaStream>>;
}

export function useMediaTransports(deps: useMediaTransportsDependencies) {
  const audioPlayoutPolicy = useRef<AudioPlayoutPolicy | null>(null);
  if (!audioPlayoutPolicy.current)
    audioPlayoutPolicy.current = new AudioPlayoutPolicy(readAudioPlayoutMode());

  useEffect(() => {
    if (!audioPlayoutPolicy.current)
      audioPlayoutPolicy.current = new AudioPlayoutPolicy(readAudioPlayoutMode());
    const policy = audioPlayoutPolicy.current;
    return () => {
      policy.dispose();
      if (audioPlayoutPolicy.current === policy) audioPlayoutPolicy.current = null;
    };
  }, []);

  // ── 初始化 mediasoup Device + 两条 transport ────────────────────────────────

  const setupDevice = useCallback(async (): Promise<boolean> => {
    if (deps.deviceRef.current && deps.sendTransport.current && deps.recvTransport.current)
      return true;
    const generation = deps.mediaGeneration.current;
    const ensureCurrent = () => {
      if (generation !== deps.mediaGeneration.current) throw new Error('语音加入已取消');
    };
    try {
      const caps = await emitAsync<RtpCapabilities>(deps.socket, 'ms:capabilities');
      ensureCurrent();
      const device = new Device();
      await device.load({ routerRtpCapabilities: caps });
      ensureCurrent();
      deps.deviceRef.current = device;

      // ── 发送 transport ───────────────────────────────────────────────────
      // Independent directions: overlap their signalling round trips. Promise.all
      // observes both rejections, including when the session is cancelled.
      const [sendParams, recvParams] = await Promise.all([
        emitAsync<Record<string, unknown>>(deps.socket, 'ms:create-transport', {
          direction: 'send',
        }),
        emitAsync<Record<string, unknown>>(deps.socket, 'ms:create-transport', {
          direction: 'recv',
        }),
      ]);
      ensureCurrent();
      const st = device.createSendTransport(sendParams as never);

      st.on('connect', ({ dtlsParameters }, ok, err) => {
        emitAsync(deps.socket, 'ms:connect-transport', {
          transportId: st.id,
          dtlsParameters,
        })
          .then(ok)
          .catch(err);
      });

      st.on('produce', ({ kind, rtpParameters, appData }, ok, err) => {
        emitAsync<{ producerId: string }>(deps.socket, 'ms:produce', {
          transportId: st.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ producerId }) => ok({ id: producerId }))
          .catch(err);
      });

      st.on('connectionstatechange', (state) => {
        if (deps.sendTransport.current !== st) return;
        deps.checkTransport('send', state);
        console.log(`%c[ms-client] 发送通道(send): ${state}`, 'color:#3b82f6;font-weight:bold');
        if (state === 'connected')
          console.log('%c[ms-client] [OK] 发送通道已连通，麦克风/屏幕可以上行', 'color:#22c55e');
        if (state === 'failed')
          console.error(
            '[ms-client] [ERROR] 发送通道连接失败 - 连接层问题，检查 frp 端口/公网IP 配置',
          );
        if (state === 'disconnected') console.warn('[ms-client] [WARN] 发送通道断开（网络抖动？）');
      });

      deps.sendTransport.current = st;

      // ── 接收 transport ───────────────────────────────────────────────────
      ensureCurrent();
      const rt = device.createRecvTransport(recvParams as never);

      rt.on('connect', ({ dtlsParameters }, ok, err) => {
        emitAsync(deps.socket, 'ms:connect-transport', {
          transportId: rt.id,
          dtlsParameters,
        })
          .then(ok)
          .catch(err);
      });

      rt.on('connectionstatechange', (state) => {
        if (deps.recvTransport.current !== rt) return;
        deps.checkTransport('recv', state);
        console.log(`%c[ms-client] 接收通道(recv): ${state}`, 'color:#a855f7;font-weight:bold');
        if (state === 'connected')
          console.log('%c[ms-client] [OK] 接收通道已连通，可以收到别人的音视频', 'color:#22c55e');
        if (state === 'failed')
          console.error(
            '[ms-client] [ERROR] 接收通道连接失败 - 连接层问题，检查 frp 端口/公网IP 配置',
          );
        if (state === 'disconnected') console.warn('[ms-client] [WARN] 接收通道断开（网络抖动？）');
      });

      deps.recvTransport.current = rt;
      return true;
    } catch (e) {
      if (generation === deps.mediaGeneration.current) {
        deps.sendTransport.current?.close();
        deps.sendTransport.current = null;
        deps.recvTransport.current?.close();
        deps.recvTransport.current = null;
        deps.deviceRef.current = null;
      }
      console.error('[mediasoup] 初始化失败:', e);
      return false;
    }
  }, [deps.socket, deps.checkTransport]);

  // ── 消费一个 producer（接收对方音频/视频）──────────────────────────────────

  const consumeProducer = useCallback(
    async (
      producerId: string,
      peerId: string,
      kind: string,
      appData: Record<string, unknown>,
      isCurrent: () => boolean = () => true,
    ): Promise<boolean> => {
      const device = deps.deviceRef.current;
      const rt = deps.recvTransport.current;
      if (!device || !rt || !isCurrent()) return false;
      if (deps.consumerByProducer.current.has(producerId)) return true;
      if (deps.pendingProducers.current.has(producerId)) return false;
      deps.pendingProducers.current.add(producerId);
      const generation = deps.mediaGeneration.current;
      let serverConsumerId: string | undefined;
      let createdConsumer: Consumer | undefined;
      let createdStream: MediaStream | undefined;
      let stopAudioPlayout = () => {};
      const cleanup = () => {
        const consumer = createdConsumer;
        if (consumer) {
          stopAudioPlayout();
          consumer.close();
          deps.consumers.current.delete(consumer.id);
          deps.detachAnalyser(consumer.id);
          if (deps.consumerByProducer.current.get(producerId) === consumer.id)
            deps.consumerByProducer.current.delete(producerId);
          deps.remoteAudioOutputs.current.get(consumer.id)?.close();
          deps.remoteAudioOutputs.current.delete(consumer.id);
          const element = deps.audioEls.current.get(consumer.id);
          if (element) {
            element.pause();
            element.srcObject = null;
            deps.audioEls.current.delete(consumer.id);
          }
          if (kind === 'video' && deps.screenStreams.current.get(peerId) === createdStream) {
            deps.screenStreams.current.delete(peerId);
            deps.setRemoteScreen(current => current?.stream === createdStream ? null : current);
          }
          if (sourceTypeForCleanup === 'screen-audio')
            deps.setScreenReceiveHasAudio(
              [...deps.consumers.current.values()].some(entry =>
                entry.sourceType === 'screen-audio' && !entry.consumer.closed),
            );
        }
        if (serverConsumerId && deps.socket.connected)
          deps.socket.emit('ms:close-consumer', { consumerId: serverConsumerId });
      };
      const sourceTypeForCleanup = typeof appData?.type === 'string' ? appData.type : undefined;
      const resume = async (consumer: Consumer) => {
        await emitAsync(deps.socket, 'ms:resume-consumer', { consumerId: consumer.id });
        if (generation !== deps.mediaGeneration.current || consumer.closed || rt.closed || !isCurrent()) {
          cleanup();
          return false;
        }
        return true;
      };

      try {
        const params = await emitAsync<Record<string, unknown>>(deps.socket, 'ms:consume', {
          producerId,
          rtpCapabilities: device.rtpCapabilities,
        });

        serverConsumerId = typeof params.id === 'string' ? params.id : undefined;
        if (generation !== deps.mediaGeneration.current || rt.closed || !isCurrent()) {
          cleanup();
          return false;
        }
        const sourceType = typeof appData?.type === 'string' ? appData.type : undefined;
        // 屏幕音画共用同步组；麦克风和独立应用音频不能混入该组。
        const streamGroup =
          sourceType === 'screen' || sourceType === 'screen-audio'
            ? 'screen'
            : sourceType === 'application-audio'
            ? 'application-audio'
            : 'mic';
        const consumer = await rt.consume({
          ...params,
          streamId: `${streamGroup}-${peerId}`,
        } as never);
        createdConsumer = consumer;
        if (generation !== deps.mediaGeneration.current || rt.closed || !isCurrent()) {
          cleanup();
          return false;
        }
        deps.consumers.current.set(consumer.id, {
          consumer,
          socketId: peerId,
          kind,
          producerId,
          sourceType,
        });
        deps.consumerByProducer.current.set(producerId, consumer.id);
        console.log(`%c[ms-client] 开始接收 ${kind} 流，来自 ${peerId}`, 'color:#06b6d4');
        const playoutPolicy = audioPlayoutPolicy.current ??
          new AudioPlayoutPolicy(readAudioPlayoutMode());
        audioPlayoutPolicy.current = playoutPolicy;
        stopAudioPlayout = playoutPolicy.watch(
          consumer,
          `${streamGroup}-${peerId}`,
          kind,
          streamGroup === 'screen',
        );

        consumer.on('trackended', () => {
          if (kind === 'video')
            deps.setRemoteScreen((current) => (current?.stream === createdStream ? null : current));
          if (sourceType === 'application-audio')
            deps.removeRemoteApplicationAudio(peerId, producerId);
          if (sourceType === 'screen-audio') {
            deps.remoteAudioOutputs.current.get(consumer.id)?.close();
            deps.remoteAudioOutputs.current.delete(consumer.id);
            deps.setScreenReceiveHasAudio(
              [...deps.consumers.current.values()].some(entry =>
                entry.consumer !== consumer && entry.sourceType === 'screen-audio' && !entry.consumer.closed),
            );
          }
        });

        const stream = new MediaStream([consumer.track]);
        createdStream = stream;

        if (kind === 'audio') {
          if (sourceType === 'screen-audio') {
            // 屏幕音频不再并入画面流：媒体元素的 volume 与
            // createMediaElementSource 对 MediaStream 播放都不生效，只有
            // Web Audio 增益能真正改变响度（与麦克风、应用音频同一条通路）。
            try {
              const context = deps.ensureAudioCtx();
              const output = createRemoteAudioOutput(
                context,
                stream,
                deps.screenReceiveVolumeRef.current,
                new Audio(),
                deps.masterOutputGain.current ?? context.destination,
              );
              deps.remoteAudioOutputs.current.set(consumer.id, output);
              void output.resume().catch((error) => {
                console.warn('[audio] 恢复共享音频输出失败，等待下一次点击重试', error);
                document.addEventListener(
                  'click',
                  () => {
                    if (deps.remoteAudioOutputs.current.get(consumer.id) === output)
                      void output.resume().catch(() => {});
                  },
                  { once: true },
                );
              });
            } catch (error) {
              console.warn('[audio] 无法播放共享音频', error);
            }
            deps.setScreenReceiveHasAudio(true);
            return await resume(consumer);
          }
          const isVoice = isMemberVoiceAudio(kind, sourceType);
          const memberVolume = deps.memberVolumesRef.current[peerId] ?? 1;
          const volume =
            sourceType === 'application-audio'
              ? deps.applicationAudioReceiveVolumesRef.current[peerId] ?? 1
              : memberVolume;
          let usesGainOutput = false;
          if (isVoice) {
            try {
              const context = deps.ensureAudioCtx();
              const output = createRemoteAudioOutput(
                context,
                stream,
                volume,
                new Audio(),
                deps.masterOutputGain.current ?? context.destination,
              );
              deps.remoteAudioOutputs.current.set(consumer.id, output);
              usesGainOutput = true;
              void output.resume().catch((error) => {
                console.warn('[audio] 恢复远端音频输出失败，等待下一次点击重试', error);
                document.addEventListener(
                  'click',
                  () => {
                    if (deps.remoteAudioOutputs.current.get(consumer.id) === output)
                      void output.resume().catch(() => {});
                  },
                  { once: true },
                );
              });
            } catch (error) {
              console.warn('[audio] 创建远端音频增益失败，回退到标准音量', error);
            }
          }
          if (!usesGainOutput) {
            // 麦克风和独立应用音频的兼容回退；屏幕音频由视频元素播放。
            const el = new Audio();
            el.autoplay = true;
            el.volume = Math.min(1, volume);
            el.muted = volume === 0;
            el.srcObject = stream;
            deps.audioEls.current.set(consumer.id, el);
            applyAudioElementOutput(el, deps.selectedAudioOutputRef.current)
              .catch((error) => {
                console.warn('[audio] 远端音频切换输出设备失败，使用系统默认设备', error);
              })
              .finally(() =>
                el.play().catch((error) => {
                  console.warn('[audio] 自动播放被阻止，等待下一次点击重试', {
                    sourceType,
                    error,
                  });
                  const resume = () => {
                    if (deps.audioEls.current.get(consumer.id) !== el) return;
                    void el.play().catch((retryError) =>
                      console.warn('[audio] 点击后仍无法播放远端音频', {
                        sourceType,
                        error: retryError,
                      }),
                    );
                  };
                  document.addEventListener('click', resume, { once: true });
                }),
              );
          }
          if (sourceType === 'application-audio') {
            // 旁路分析不会连接扬声器；电平按当前实际播放路径的增益计算。
            deps.attachAnalyser(consumer.id, stream, peerId, 'application', () => {
              const element = deps.audioEls.current.get(consumer.id);
              if (!element || element.paused) return 0;
              const output = deps.remoteAudioOutputs.current.get(consumer.id);
              if (output)
                return deps.audioCtxRef.current?.state === 'running'
                  ? output.gain.gain.value * deps.masterOutputVolumeRef.current
                  : 0;
              return element.muted ? 0 : element.volume;
            });
            deps.startMeters();
          } else if (isVoice) {
            deps.attachAnalyser(consumer.id, stream, peerId);
            deps.startMeters();
          }
        } else if (kind === 'video') {
          // appData.type === 'screen'：画面流只含视频，音频走各自的增益通路。
          deps.screenStreams.current.set(peerId, stream);
          deps.setRemoteScreen({ socketId: peerId, stream });
        }

        // Prepare the sink before asking the server to forward the first media
        // packets. Waiting for the ACK first needlessly stalls first playback.
        return await resume(consumer);
      } catch (e) {
        cleanup();
        console.error('[mediasoup] consume 失败:', e);
        return false;
      } finally {
        if (generation === deps.mediaGeneration.current)
          deps.pendingProducers.current.delete(producerId);
      }
    },
    [deps.removeRemoteApplicationAudio, deps.socket],
  );
  return { setupDevice, consumeProducer };
}
