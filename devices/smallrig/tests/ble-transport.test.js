import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Bluetooth as WebBluetooth } from 'webbluetooth';
import {
  GATT,
  openBrokeredGattConnection,
  openGattConnection,
  parseLampAdvertisement
} from '../src/ble/ble-transport.js';

const require = createRequire(import.meta.url);
const { SimplebleAdapter } = require('../node_modules/webbluetooth/dist/adapters/simpleble-adapter.js');
const { BluetoothRemoteGATTServer } = require('../node_modules/webbluetooth/dist/server.js');
const { adapter: sharedAdapter } = require('../node_modules/webbluetooth/dist/adapters/index.js');
const simplebleBinding = require('../node_modules/webbluetooth/dist/adapters/simpleble.js');

test('importer ble-transport dans le parent ne charge pas webbluetooth/SimpleBLE', () => {
  const moduleUrl = new URL('../src/ble/ble-transport.js', import.meta.url).href;
  const probe = [
    "import { createRequire } from 'node:module';",
    `await import(${JSON.stringify(moduleUrl)});`,
    'const require = createRequire(import.meta.url);',
    "const loaded = Object.keys(require.cache).some((entry) => /node_modules[\\\\/]webbluetooth[\\\\/]/i.test(entry));",
    "process.stdout.write(loaded ? 'loaded' : 'isolated');"
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'isolated');
});

function uuid(shortUuid) {
  return `0000${shortUuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

function createGattFixture({ connectError, notificationError, disconnectError } = {}) {
  const calls = [];
  const listeners = new Map();
  const writes = [];
  let connected = false;

  const dataIn = {
    async writeValueWithoutResponse(value) {
      calls.push('write');
      writes.push(value);
    }
  };
  const dataOut = {
    value: undefined,
    addEventListener(type, listener) {
      calls.push('add-listener');
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      calls.push('remove-listener');
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    async startNotifications() {
      calls.push('start-notifications');
      if (notificationError) throw notificationError;
      return this;
    },
    async stopNotifications() {
      calls.push('stop-notifications');
      return this;
    }
  };
  const service = {
    async getCharacteristic(characteristicUuid) {
      calls.push(`characteristic:${characteristicUuid}`);
      if (characteristicUuid === uuid(GATT.PROVISIONING_DATA_IN)) return dataIn;
      if (characteristicUuid === uuid(GATT.PROVISIONING_DATA_OUT)) return dataOut;
      throw new Error(`Unexpected characteristic ${characteristicUuid}`);
    }
  };
  const server = {
    async getPrimaryService(serviceUuid) {
      calls.push(`service:${serviceUuid}`);
      return service;
    }
  };
  const gatt = {
    get connected() {
      return connected;
    },
    async connect() {
      calls.push('connect');
      if (connectError) throw connectError;
      connected = true;
      return server;
    },
    async disconnect() {
      calls.push('disconnect');
      connected = false;
      if (disconnectError) throw disconnectError;
    }
  };

  return { device: { gatt }, calls, dataOut, listeners, writes };
}

const provisioningOptions = {
  serviceUuid: GATT.PROVISIONING_SERVICE,
  dataInUuid: GATT.PROVISIONING_DATA_IN,
  dataOutUuid: GATT.PROVISIONING_DATA_OUT
};

test('openGattConnection ouvre une fois, écrit un buffer exact et ferme une fois', async () => {
  const fixture = createGattFixture();
  const received = [];
  const connection = await openGattConnection(fixture.device, {
    ...provisioningOptions,
    onData: (data) => received.push(data)
  });

  assert.equal(connection.connected, true);
  assert.deepEqual(fixture.calls.slice(0, 5), [
    'connect',
    `service:${uuid(GATT.PROVISIONING_SERVICE)}`,
    `characteristic:${uuid(GATT.PROVISIONING_DATA_IN)}`,
    `characteristic:${uuid(GATT.PROVISIONING_DATA_OUT)}`,
    'add-listener'
  ]);
  assert.equal(fixture.calls[5], 'start-notifications');

  const pooled = Buffer.from([0xaa, 0x01, 0x02, 0x03, 0xbb]);
  await connection.write(pooled.subarray(1, 4));
  assert.equal(fixture.writes.length, 1);
  assert.ok(fixture.writes[0] instanceof Uint8Array);
  assert.equal(fixture.writes[0].buffer.byteLength, 3);
  assert.deepEqual([...fixture.writes[0]], [1, 2, 3]);

  fixture.dataOut.value = new DataView(Uint8Array.from([4, 5, 6]).buffer);
  fixture.listeners.get('characteristicvaluechanged')();
  assert.deepEqual(received, [Buffer.from([4, 5, 6])]);

  await connection.close();
  await connection.close();
  assert.equal(connection.connected, false);
  assert.equal(fixture.calls.filter((call) => call === 'disconnect').length, 1);
  assert.equal(fixture.calls.filter((call) => call === 'stop-notifications').length, 1);
  assert.equal(fixture.calls.filter((call) => call === 'remove-listener').length, 1);
});

test('une notification GATT mal formée ne propage pas une exception globale', async () => {
  const fixture = createGattFixture();
  const connection = await openGattConnection(fixture.device, {
    ...provisioningOptions,
    onData: () => { throw new Error('PDU invalide'); }
  });
  fixture.dataOut.value = new DataView(Uint8Array.from([0xff]).buffer);

  assert.doesNotThrow(() => fixture.listeners.get('characteristicvaluechanged')());
  await connection.close();
});

test('openGattConnection ne retry pas et conserve le diagnostic natif dans cause', async () => {
  const nativeError = Object.assign(new Error('Connect failed from native mock'), {
    code: 'SIMPLEBLE_CONNECT_FAILED',
    nativeDiagnostics: { connected: true, connectable: false, serviceCount: 0 }
  });
  const fixture = createGattFixture({ connectError: nativeError });

  await assert.rejects(
    openGattConnection(fixture.device, provisioningOptions),
    (error) => {
      assert.equal(error.cause, nativeError);
      assert.equal(error.code, nativeError.code);
      assert.equal(error.nativeDiagnostics, nativeError.nativeDiagnostics);
      assert.match(error.message, /connexion au périphérique/);
      assert.match(error.message, /Connect failed from native mock/);
      return true;
    }
  );

  assert.equal(fixture.calls.filter((call) => call === 'connect').length, 1);
  assert.equal(fixture.calls.filter((call) => call === 'disconnect').length, 1);
});

test('un échec de notifications retire le listener et ne masque pas un échec de nettoyage', async () => {
  const notificationError = Object.assign(new Error('CCCD write failed'), { code: 'NATIVE_CCCD_FAILURE' });
  const disconnectError = new Error('native disconnect timeout');
  const fixture = createGattFixture({ notificationError, disconnectError });

  await assert.rejects(
    openGattConnection(fixture.device, provisioningOptions),
    (error) => {
      assert.equal(error.cause, notificationError);
      assert.equal(error.code, notificationError.code);
      assert.deepEqual(error.cleanupErrors, [disconnectError]);
      assert.match(error.message, /activation des notifications/);
      assert.match(error.message, /native disconnect timeout/);
      return true;
    }
  );

  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.calls.filter((call) => call === 'connect').length, 1);
  assert.equal(fixture.calls.filter((call) => call === 'disconnect').length, 1);
  assert.equal(fixture.calls.filter((call) => call === 'remove-listener').length, 1);
});

function nativeService(serviceUuid) {
  return {
    uuid: serviceUuid,
    characteristics: [{
      uuid: '00002add-0000-1000-8000-00805f9b34fb',
      canNotify: true,
      canIndicate: false,
      descriptors: []
    }]
  };
}

function nativePeripheral(address, serviceUuid, events = []) {
  return {
    address,
    connected: true,
    connectable: true,
    services: [nativeService(serviceUuid)],
    connect() {
      events.push(`connect:${serviceUuid}`);
      return true;
    },
    disconnect() {
      events.push(`disconnect:${serviceUuid}`);
      this.connected = false;
      return true;
    },
    setCallbackOnDisconnected() {
      return true;
    },
    notify(service, characteristic, callback) {
      events.push(`notify:${service}:${characteristic}`);
      this.notificationCallback = callback;
      return true;
    },
    unsubscribe(service, characteristic) {
      events.push(`unsubscribe:${service}:${characteristic}`);
      return true;
    }
  };
}

test('SimpleBLE arrête le scan avant connect et remonte un échec structuré sans déconnecter lui-même', async () => {
  const simpleble = new SimplebleAdapter();
  const events = [];
  let disconnectCalls = 0;
  const peripheral = {
    address: 'AA:BB:CC:DD:EE:FF',
    connected: true,
    connectable: false,
    services: [],
    connect() {
      events.push('connect');
      return false;
    },
    disconnect() {
      disconnectCalls += 1;
      return true;
    }
  };
  simpleble.adapter = {
    scanStop() {
      events.push('scan-stop');
      return true;
    }
  };
  simpleble.scanning = true;
  simpleble.peripherals.set(peripheral.address, peripheral);

  const connecting = simpleble.connect(peripheral.address);
  assert.deepEqual(events, ['scan-stop']);
  assert.equal(simpleble.scanning, true);
  simpleble.scanStopResolve();

  await assert.rejects(connecting, (error) => {
    assert.equal(error.code, 'SIMPLEBLE_CONNECT_FAILED');
    assert.deepEqual(error.nativeDiagnostics, {
      connected: true,
      connectable: false,
      serviceCount: 0
    });
    return true;
  });

  assert.deepEqual(events, ['scan-stop', 'connect']);
  assert.equal(disconnectCalls, 0);
  assert.equal(simpleble.scanning, false);
});

test('SimpleBLE conserve le détail WinRT lorsqu’un connect natif lève une exception', async () => {
  const simpleble = new SimplebleAdapter();
  const nativeError = new Error('WinRT 0x8007001F pendant GetGattServicesForUuidAsync');
  const peripheral = {
    address: 'AA:BB:CC:DD:EE:F1',
    connected: true,
    connectable: true,
    services: [],
    connect() {
      throw nativeError;
    }
  };
  simpleble.peripherals.set(peripheral.address, peripheral);

  await assert.rejects(simpleble.connect(peripheral.address), (error) => {
    assert.equal(error.code, 'SIMPLEBLE_CONNECT_FAILED');
    assert.equal(error.cause, nativeError);
    assert.match(error.message, /GetGattServicesForUuidAsync/);
    assert.deepEqual(error.nativeDiagnostics, {
      connected: true,
      connectable: true,
      serviceCount: 0
    });
    return true;
  });
});

test('Bluetooth.cancelRequest reste en attente de la confirmation d’arrêt', async () => {
  const originalStopScan = sharedAdapter.stopScan;
  let confirmStop;
  const nativeConfirmation = new Promise((resolve) => { confirmStop = resolve; });
  sharedAdapter.stopScan = () => nativeConfirmation;
  const bluetooth = new WebBluetooth();
  bluetooth.scanner = setTimeout(() => {}, 10000);

  try {
    let settled = false;
    const pending = bluetooth.cancelRequest().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    confirmStop();
    await pending;
    assert.equal(settled, true);
  } finally {
    sharedAdapter.stopScan = originalStopScan;
    if (bluetooth.scanner) clearTimeout(bluetooth.scanner);
  }
});

test('SimpleBLE bloque connect si le scan ne peut pas être arrêté', async () => {
  const simpleble = new SimplebleAdapter();
  let connectCalls = 0;
  const peripheral = {
    address: 'AA:BB:CC:DD:EE:00',
    services: [],
    connect() {
      connectCalls += 1;
      return true;
    }
  };
  simpleble.adapter = { scanStop: () => false };
  simpleble.scanning = true;
  simpleble.peripherals.set(peripheral.address, peripheral);

  await assert.rejects(simpleble.connect(peripheral.address), /scan stop failed/);
  assert.equal(connectCalls, 0);
  assert.equal(simpleble.scanning, true);
});

test('SimpleBLE remplace le graphe 0x1827 par 0x1828 et le purge à la déconnexion', async () => {
  const simpleble = new SimplebleAdapter();
  const events = [];
  const address = 'AA:BB:CC:DD:EE:11';
  const provisioning = nativePeripheral(address, uuid(GATT.PROVISIONING_SERVICE), events);
  simpleble.peripherals.set(address, provisioning);

  await simpleble.connect(address);
  const firstServices = await simpleble.discoverServices(address, []);
  assert.deepEqual(firstServices.map((service) => service.uuid), [uuid(GATT.PROVISIONING_SERVICE)]);
  const firstHandle = firstServices[0]._handle;
  assert.equal(simpleble.handles.services.size, 1);
  assert.equal(simpleble.handles.characteristics.size, 1);

  const proxy = nativePeripheral(address, uuid(GATT.PROXY_SERVICE), events);
  simpleble.peripherals.set(address, proxy);
  await simpleble.connect(address);

  const secondServices = await simpleble.discoverServices(address, []);
  assert.deepEqual(secondServices.map((service) => service.uuid), [uuid(GATT.PROXY_SERVICE)]);
  assert.notEqual(secondServices[0]._handle, firstHandle);
  assert.equal(simpleble.handles.services.size, 1);
  assert.equal(simpleble.handles.characteristics.size, 1);
  assert.equal(simpleble.handles.peripheralChildren.size, 1);

  await simpleble.disconnect(address);
  assert.equal(simpleble.handles.services.size, 0);
  assert.equal(simpleble.handles.characteristics.size, 0);
  assert.equal(simpleble.handles.descriptors.size, 0);
  assert.equal(simpleble.handles.parents.size, 0);
  assert.equal(simpleble.handles.peripheralChildren.size, 0);
  assert.equal(simpleble.handles.children.has(address), false);
});

test('SimpleBLE souscrit uniquement à startNotifications puis se désabonne réellement', async () => {
  const simpleble = new SimplebleAdapter();
  const events = [];
  const address = 'AA:BB:CC:DD:EE:12';
  const peripheral = nativePeripheral(address, uuid(GATT.PROVISIONING_SERVICE), events);
  simpleble.peripherals.set(address, peripheral);

  await simpleble.connect(address);
  const [service] = await simpleble.discoverServices(address, []);
  const [characteristic] = await simpleble.discoverCharacteristics(service._handle, []);
  assert.equal(events.some((event) => event.startsWith('notify:')), false);

  const received = [];
  await simpleble.enableNotify(characteristic._handle, (data) => received.push(data));
  assert.equal(events.filter((event) => event.startsWith('notify:')).length, 1);

  peripheral.notificationCallback(Uint8Array.from([1, 2, 3]));
  assert.equal(received.length, 1);
  assert.deepEqual([...new Uint8Array(received[0].buffer, received[0].byteOffset, received[0].byteLength)], [1, 2, 3]);

  await simpleble.disableNotify(characteristic._handle);
  assert.equal(events.filter((event) => event.startsWith('unsubscribe:')).length, 1);
  assert.equal(simpleble.handles.characteristicEvents.size, 0);
});

test('useAdapter reconstruit l’adaptateur natif et purge peripherals/handles à chaque scan', () => {
  const originalGetAdapters = simplebleBinding.getAdapters;
  let generation = 0;
  simplebleBinding.getAdapters = () => [{ generation: ++generation }];
  const simpleble = new SimplebleAdapter();
  const address = 'AA:BB:CC:DD:EE:22';

  try {
    simpleble.useAdapter(0);
    const firstAdapter = simpleble.adapter;
    const stale = nativePeripheral(address, uuid(GATT.PROVISIONING_SERVICE));
    simpleble.peripherals.set(address, stale);
    simpleble.handles.createHandles(stale);
    assert.equal(simpleble.handles.services.size, 1);

    simpleble.useAdapter(0);
    assert.notEqual(simpleble.adapter, firstAdapter);
    assert.equal(simpleble.adapter.generation, 2);
    assert.equal(simpleble.peripherals.size, 0);
    assert.equal(simpleble.handles.services.size, 0);
    assert.equal(simpleble.handles.peripheralChildren.size, 0);
  } finally {
    simplebleBinding.getAdapters = originalGetAdapters;
  }
});

test('une annonce ambiguë 0x1827 + 0x1828 est classée dans l’état Proxy le plus récent', () => {
  const deviceUuid = Uint8Array.from({ length: 16 }, (_, index) => index);
  const networkId = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const device = {
    id: 'transition-device',
    name: 'RM75',
    _adData: {
      rssi: -42,
      serviceData: new Map([
        [uuid(GATT.PROVISIONING_SERVICE), deviceUuid],
        [uuid(GATT.PROXY_SERVICE), Uint8Array.from([0x00, ...networkId])]
      ])
    }
  };

  const parsed = parseLampAdvertisement(device);
  assert.equal(parsed.kind, 'provisioned');
  assert.deepEqual(parsed.networkId, Buffer.from(networkId));
  assert.equal(parsed.device, device);
});

test('BluetoothRemoteGATTServer.disconnect retourne la promesse native observable', async () => {
  const originalDisconnect = sharedAdapter.disconnect;
  const nativeError = new Error('observable native disconnect failure');
  const device = { id: 'mock-device' };
  const server = new BluetoothRemoteGATTServer(device);
  server.services = [{}];
  sharedAdapter.disconnect = () => Promise.reject(nativeError);

  try {
    const pending = server.disconnect();
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, (error) => error === nativeError);
    assert.equal(server.connected, false);
    assert.equal(server.services, undefined);
  } finally {
    sharedAdapter.disconnect = originalDisconnect;
  }
});

test('le broker conserve la session GATT dans le worker et sérialise écritures/notifications', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
      this.killed = false;
    }

    send(message) {
      this.sent.push(message);
      setImmediate(() => {
        if (message.operation === 'open') {
          this.emit('message', {
            type: 'response', requestId: message.requestId, ok: true,
            result: { maxAttributeValueLength: 20, selectedDevice: { bleDeviceId: 'rotated-rpa' } }
          });
        } else {
          this.emit('message', { type: 'response', requestId: message.requestId, ok: true, result: {} });
        }
      });
    }

    kill() {
      this.killed = true;
      return true;
    }
  }

  const child = new FakeChild();
  let forkOptions;
  const notifications = [];
  const connection = await openBrokeredGattConnection('provisioning', {
    bleDeviceId: 'old-rpa',
    deviceUuid: 'ab'.repeat(16)
  }, {
    onData: (bytes) => notifications.push(bytes),
    forkProcess: (_modulePath, _args, options) => {
      forkOptions = options;
      return child;
    }
  });

  assert.equal(connection.connected, true);
  assert.equal(forkOptions.windowsHide, true);
  assert.equal(forkOptions.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(connection.selectedDevice.bleDeviceId, 'rotated-rpa');
  assert.deepEqual(child.sent[0].payload.selector, {
    bleDeviceId: 'old-rpa', deviceUuid: 'ab'.repeat(16), networkId: null
  });

  child.emit('message', { type: 'notification', data: Buffer.from([1, 2, 3]).toString('base64') });
  assert.deepEqual(notifications, [Buffer.from([1, 2, 3])]);

  await connection.write(Buffer.from([4, 5, 6]));
  assert.equal(child.sent[1].operation, 'write');
  assert.deepEqual(Buffer.from(child.sent[1].payload.data, 'base64'), Buffer.from([4, 5, 6]));

  await connection.close();
  assert.equal(connection.connected, false);
  assert.equal(child.sent[2].operation, 'close');
  assert.equal(child.killed, true);
});

test('le timeout dur du broker tue seulement le worker bloqué', async () => {
  class BlockedChild extends EventEmitter {
    send() {}
    kill() { this.killed = true; return true; }
  }
  const child = new BlockedChild();
  await assert.rejects(
    openBrokeredGattConnection('provisioning', { bleDeviceId: 'stuck' }, {
      forkProcess: () => child,
      openTimeoutMs: 20
    }),
    (error) => error.code === 'SMALLRIG_BLE_WORKER_TIMEOUT'
  );
  assert.equal(child.killed, true);
});
