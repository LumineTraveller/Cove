import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type AcknowledgedTransport } from '../src/request';
test('disconnected requests do not send or change another session', async () => {
  let sent = false;
  const transport = {
    connected: false,
    emit() {
      sent = true;
    },
  };
  await assert.rejects(request(transport, 'voice:join'), /重连/);
  assert.equal(sent, false);
});
test('returns legacy success payloads and rejects only the requested operation', async () => {
  const transport: AcknowledgedTransport = {
    connected: true,
    emit(_event, _payload, ack) {
      ack({ id: 'producer-1' });
    },
  };
  assert.deepEqual(await request(transport, 'ms:produce'), { id: 'producer-1' });
  transport.emit = (_event, _payload, ack) => ack({ error: '语音包不存在' });
  await assert.rejects(request(transport, 'soundpack:delete'), /不存在/);
  assert.equal(transport.connected, true);
});
test('timeouts retain platform text and ignore late acknowledgements', async () => {
  let ack: (value: unknown) => void = () => {};
  const transport: AcknowledgedTransport = {
    connected: true,
    emit(_event, _payload, callback) {
      ack = callback;
    },
  };
  await assert.rejects(
    request(transport, 'ms:consume', null, {
      timeoutMs: 5,
      timeoutMessage: (event) => `${event} 超时`,
    }),
    /ms:consume 超时/,
  );
  ack({ id: 'late' });
});
test('synchronous transport failure clears its timer', async () => {
  const transport: AcknowledgedTransport = {
    connected: true,
    emit() {
      throw new Error('send failed');
    },
  };
  await assert.rejects(request(transport, 'voice:join'), /send failed/);
});
