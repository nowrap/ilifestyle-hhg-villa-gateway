'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { once } = require('node:events');
const { BaresipControl } = require('../src/baresip-control');

function frame(value) {
  const json = JSON.stringify(value);
  return `${Buffer.byteLength(json)}:${json},`;
}

function readFrame(socket, callback) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const colon = buffer.indexOf(58);
    if (colon < 1) return;
    const length = Number(buffer.subarray(0, colon).toString());
    if (buffer.length < colon + length + 2) return;
    callback(JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString()));
  });
}

test('keeps Baresip call event IDs distinct and multiplexes command responses', async (t) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();

  server.on('connection', (socket) => {
    socket.write(frame(null));
    socket.write(frame({ event: true, class: 'call', type: 'CALL_INCOMING', id: 'call-a' }));
    socket.write(frame({ event: true, class: 'call', type: 'CALL_CLOSED', id: 'call-a' }));
    socket.write(frame({ event: true, class: 'call', type: 'CALL_INCOMING', id: 'call-b' }));
    readFrame(socket, (request) => {
      socket.write(frame({ response: true, ok: true, token: request.token, data: 'Active calls (1)' }));
    });
  });

  const client = new BaresipControl({ host: '127.0.0.1', port: address.port, reconnectMs: 20 });
  const ids = [];
  client.on('callEvent', (event) => ids.push(event.id));
  client.start();
  await once(client, 'connect');
  assert.equal(await client.command('listcalls'), 'Active calls (1)');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ids, ['call-a', 'call-a', 'call-b']);
  assert.notEqual(ids[0], ids[2]);
  client.stop();
});
test('rejects commands while disconnected instead of queueing them', async () => {
  const client = new BaresipControl({ host: '127.0.0.1', port: 9 });
  await assert.rejects(client.command('accept'), /not connected/);
});
