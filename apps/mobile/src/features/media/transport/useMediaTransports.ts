import { useCallback } from 'react';

import type { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';

import { MediaStream, MediaStreamTrack } from 'react-native-webrtc';

import {
  Transport,
  Consumer,
  RtpCapabilities,
  RemoteScreen,
  ApplicationAudioShare,
  ConnectionState,
  emitAsync,
} from '../mobileMediaSupport';

export interface UseMediaTransportsDependencies {
  readonly deviceRef: import('react').RefObject<Device | null>;
  readonly sendTransport: import('react').RefObject<Transport | null>;
  readonly recvTransport: import('react').RefObject<Transport | null>;
  readonly mediaGeneration: import('react').RefObject<number>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly checkTransport: (key: string, state: string) => void;
  readonly setConnectionState: import('react').Dispatch<
    import('react').SetStateAction<ConnectionState>
  >;
  readonly consumers: import('react').RefObject<
    Map<
      string,
      {
        consumer: Consumer;
        producerId: string;
        socketId: string;
        kind: string;
        stream: MediaStream;
        sourceType?: string;
      }
    >
  >;
  readonly consumerByProducer: import('react').RefObject<Map<string, string>>;
  readonly applicationAudioVolumes: import('react').RefObject<
    Map<string, number>
  >;
  readonly setApplicationAudioShares: import('react').Dispatch<
    import('react').SetStateAction<ApplicationAudioShare[]>
  >;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly inVoiceRef: import('react').RefObject<boolean>;
  readonly closedProducers: import('react').RefObject<Set<string>>;
  readonly pendingProducers: import('react').RefObject<Set<string>>;
  readonly screenReceiveVolumeRef: import('react').RefObject<number>;
  readonly memberVolumesRef: import('react').RefObject<Map<string, number>>;
  readonly setError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
}

export function useMediaTransports(deps: UseMediaTransportsDependencies) {
  const {
    deviceRef,
    sendTransport,
    recvTransport,
    mediaGeneration,
    socket,
    checkTransport,
    setConnectionState,
    consumers,
    consumerByProducer,
    applicationAudioVolumes,
    setApplicationAudioShares,
    setRemoteScreen,
    inVoiceRef,
    closedProducers,
    pendingProducers,
    screenReceiveVolumeRef,
    memberVolumesRef,
    setError,
  } = deps;

  const setupDevice = useCallback(async () => {
    if (deviceRef.current && sendTransport.current && recvTransport.current)
      return;
    const generation = mediaGeneration.current;
    const ensureCurrent = () => {
      if (generation !== mediaGeneration.current)
        throw new Error('语音加入已取消');
    };

    const capabilities = await emitAsync<RtpCapabilities>(
      socket,
      'ms:capabilities',
    );
    ensureCurrent();
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities: capabilities });
    ensureCurrent();
    deviceRef.current = device;

    // Send and receive transports are independent; do not serialize two RTTs.
    const [sendParams, recvParams] = await Promise.all([
      emitAsync<Record<string, unknown>>(socket, 'ms:create-transport', {
        direction: 'send',
      }),
      emitAsync<Record<string, unknown>>(socket, 'ms:create-transport', {
        direction: 'recv',
      }),
    ]);
    ensureCurrent();
    const outgoing = device.createSendTransport(sendParams as never);
    outgoing.on('connect', ({ dtlsParameters }, resolve, reject) => {
      emitAsync(socket, 'ms:connect-transport', {
        transportId: outgoing.id,
        dtlsParameters,
      })
        .then(resolve)
        .catch(reject);
    });
    outgoing.on(
      'produce',
      ({ kind, rtpParameters, appData }, resolve, reject) => {
        emitAsync<{ producerId: string }>(socket, 'ms:produce', {
          transportId: outgoing.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ producerId }) => resolve({ id: producerId }))
          .catch(reject);
      },
    );
    outgoing.on('connectionstatechange', state => {
      if (sendTransport.current !== outgoing) return;
      checkTransport('send', state);
      if (state === 'connecting') setConnectionState('connecting');
      if (state === 'connected') setConnectionState('connected');
    });
    sendTransport.current = outgoing;

    ensureCurrent();
    const incoming = device.createRecvTransport(recvParams as never);
    incoming.on('connect', ({ dtlsParameters }, resolve, reject) => {
      emitAsync(socket, 'ms:connect-transport', {
        transportId: incoming.id,
        dtlsParameters,
      })
        .then(resolve)
        .catch(reject);
    });
    incoming.on('connectionstatechange', state => {
      if (recvTransport.current !== incoming) return;
      checkTransport('recv', state);
      if (state === 'connecting') setConnectionState('connecting');
      if (state === 'connected') setConnectionState('connected');
    });
    recvTransport.current = incoming;
  }, [
    deviceRef,
    sendTransport,
    recvTransport,
    mediaGeneration,
    socket,
    checkTransport,
    setConnectionState,
  ]);

  const removeConsumer = useCallback(
    (consumerId: string, notifyServer = false) => {
      const entry = consumers.current.get(consumerId);
      if (!entry) return;
      consumers.current.delete(consumerId);
      if (consumerByProducer.current.get(entry.producerId) === consumerId)
        consumerByProducer.current.delete(entry.producerId);
      entry.consumer.close();
      if (notifyServer && socket.connected)
        socket.emit('ms:close-consumer', { consumerId });
      entry.stream.release(false);
      if (entry.sourceType === 'application-audio') {
        applicationAudioVolumes.current.delete(entry.producerId);
        setApplicationAudioShares(current =>
          current.filter(share => share.producerId !== entry.producerId),
        );
      }
      if (entry.kind === 'video') {
        setRemoteScreen(current =>
          current?.consumerId === consumerId ? null : current,
        );
      }
    },
    [
      applicationAudioVolumes,
      consumerByProducer,
      consumers,
      setApplicationAudioShares,
      setRemoteScreen,
      socket,
    ],
  );

  const consumeProducer = useCallback(
    async (
      producerId: string,
      peerId: string,
      kind: string,
      appData: Record<string, unknown> = {},
      isCurrent: () => boolean = () => true,
    ) => {
      const device = deviceRef.current;
      const incoming = recvTransport.current;
      const generation = mediaGeneration.current;
      if (
        !device ||
        !incoming ||
        !isCurrent() ||
        !inVoiceRef.current ||
        closedProducers.current.has(producerId)
      )
        return false;
      if (consumerByProducer.current.has(producerId)) return true;
      // A pending request may belong to a cancelled watch. Reporting success
      // would leave a new watch selected after that old request cleans itself up.
      if (pendingProducers.current.has(producerId)) return false;
      pendingProducers.current.add(producerId);
      let createdConsumer: Consumer | undefined;
      let serverConsumerId: string | undefined;
      const isStale = () =>
        generation !== mediaGeneration.current ||
        !isCurrent() ||
        !inVoiceRef.current ||
        closedProducers.current.has(producerId);

      try {
        const params = await emitAsync<Record<string, unknown>>(
          socket,
          'ms:consume',
          {
            producerId,
            rtpCapabilities: device.rtpCapabilities,
          },
        );
        serverConsumerId = typeof params.id === 'string' ? params.id : undefined;
        if (isStale()) {
          if (socket.connected && params.id)
            socket.emit('ms:close-consumer', { consumerId: params.id });
          return false;
        }
        const sourceType = appData.type;
        const streamGroup =
          sourceType === 'screen' || sourceType === 'screen-audio'
            ? 'screen'
            : sourceType === 'application-audio'
            ? 'application-audio'
            : 'mic';
        const consumer = await incoming.consume({
          ...params,
          streamId: `${streamGroup}-${peerId}`,
        } as never);
        createdConsumer = consumer;
        if (isStale()) {
          consumer.close();
          if (socket.connected)
            socket.emit('ms:close-consumer', { consumerId: consumer.id });
          return false;
        }
        consumer.track.enabled = true;
        const stream = new MediaStream([
          consumer.track as unknown as MediaStreamTrack,
        ]);
        consumers.current.set(consumer.id, {
          consumer,
          producerId,
          socketId: peerId,
          kind,
          stream,
          sourceType:
            typeof appData.type === 'string' ? appData.type : undefined,
        });
        consumerByProducer.current.set(producerId, consumer.id);
        if (kind === 'video') {
          setRemoteScreen({
            socketId: peerId,
            consumerId: consumer.id,
            stream,
          });
        }
        if (appData.type === 'screen-audio') {
          const adjustableTrack = consumer.track as unknown as {
            _setVolume?: (volume: number) => void;
          };
          adjustableTrack._setVolume?.(screenReceiveVolumeRef.current);
        }
        if (kind === 'audio' && appData.type === 'application-audio') {
          const volume = applicationAudioVolumes.current.get(producerId) ?? 1;
          applicationAudioVolumes.current.set(producerId, volume);
          (consumer.track as unknown as MediaStreamTrack)._setVolume(volume);
          setApplicationAudioShares(current => [
            ...current.filter(share => share.producerId !== producerId),
            {
              producerId,
              socketId: peerId,
              label: typeof appData.label === 'string' ? appData.label : '应用',
              volume,
            },
          ]);
        }
        if (
          kind === 'audio' &&
          (appData.type === 'mic' || appData.type == null)
        ) {
          (consumer.track as unknown as MediaStreamTrack)._setVolume(
            memberVolumesRef.current.get(peerId) ?? 1,
          );
        }
        consumer.on('trackended', () => removeConsumer(consumer.id));
        consumer.on('transportclose', () => removeConsumer(consumer.id));
        // Attach the screen and apply receive volume before the first packets
        // arrive, rather than waiting an extra signalling RTT to prepare output.
        await emitAsync(socket, 'ms:resume-consumer', {
          consumerId: consumer.id,
        });
        if (isStale() || consumer.closed || incoming.closed) {
          removeConsumer(consumer.id, true);
          return false;
        }
        return true;
      } catch (cause) {
        if (createdConsumer && consumers.current.has(createdConsumer.id)) {
          removeConsumer(createdConsumer.id, true);
        } else {
          createdConsumer?.close();
          if (socket.connected && serverConsumerId)
            socket.emit('ms:close-consumer', { consumerId: serverConsumerId });
        }
        if (!isStale())
          setError(cause instanceof Error ? cause.message : '无法接收媒体流');
        return false;
      } finally {
        if (generation === mediaGeneration.current)
          pendingProducers.current.delete(producerId);
      }
    },
    [
      applicationAudioVolumes,
      closedProducers,
      consumerByProducer,
      consumers,
      deviceRef,
      inVoiceRef,
      mediaGeneration,
      memberVolumesRef,
      pendingProducers,
      recvTransport,
      removeConsumer,
      screenReceiveVolumeRef,
      setApplicationAudioShares,
      setError,
      setRemoteScreen,
      socket,
    ],
  );
  return { setupDevice, removeConsumer, consumeProducer };
}
