import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createDeviceAgent, PROTOCOL_VERSION } from '../src/device-agent.js';

async function startCompanion() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const connections = [];
  wss.on('connection', (ws, req) => {
    const connection = { ws, headers: req.headers, messages: [] };
    ws.on('message', (data) => connection.messages.push(JSON.parse(data.toString())));
    connections.push(connection);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `ws://127.0.0.1:${port}/devices/ws`, connections, stop: () => new Promise((resolve) => { wss.close(); server.close(resolve); }) };
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('l’agent s’authentifie, annonce ses éléments en protocole 2 et acquitte les commandes', async () => {
  const companion = await startCompanion();
  const agent = createDeviceAgent({
    url: companion.url,
    token: 'kxd_test',
    deviceId: 'smallrig',
    name: 'Lampes SmallRig',
    getElements: () => [{ id: 'u1', type: 'light', actions: ['set'] }],
    onCommand: async (elementId, action, payload) => {
      if (payload.fail) throw new Error('boum');
      return { elementId, action };
    }
  });

  try {
    agent.start();
    await waitFor(() => companion.connections.length === 1 && companion.connections[0].messages.length === 1);
    const [connection] = companion.connections;
    assert.equal(connection.headers.authorization, 'Bearer kxd_test');
    assert.deepEqual(connection.messages[0], {
      type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceId: 'smallrig', name: 'Lampes SmallRig',
      elements: [{ id: 'u1', type: 'light', actions: ['set'] }]
    });
    assert.equal(PROTOCOL_VERSION, 2);

    connection.ws.send(JSON.stringify({ type: 'registered', ok: true }));
    connection.ws.send(JSON.stringify({ type: 'command', id: 'c1', elementId: 'u1', action: 'set', payload: {}, data: {} }));
    connection.ws.send(JSON.stringify({ type: 'command', id: 'c2', elementId: 'u1', action: 'set', payload: { fail: true }, data: {} }));
    await waitFor(() => connection.messages.length === 3);

    assert.deepEqual(connection.messages[1], { type: 'ack', id: 'c1', ok: true, result: { elementId: 'u1', action: 'set' } });
    assert.deepEqual(connection.messages[2], { type: 'ack', id: 'c2', ok: false, error: 'boum' });
  } finally {
    agent.stop();
    await companion.stop();
  }
});

test('l’agent se reconnecte après une coupure', async () => {
  const companion = await startCompanion();
  const agent = createDeviceAgent({
    url: companion.url, token: 't', deviceId: 'd', getElements: () => [], onCommand: async () => ({}),
    reconnectMinMs: 20, reconnectMaxMs: 40
  });

  try {
    agent.start();
    await waitFor(() => companion.connections.length === 1);
    companion.connections[0].ws.close(4409, 're-registered');
    await waitFor(() => companion.connections.length === 2);
  } finally {
    agent.stop();
    await companion.stop();
  }
});
