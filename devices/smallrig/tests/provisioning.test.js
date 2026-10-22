import test from 'node:test';
import assert from 'node:assert/strict';
import { runProvisioning, simulateDeviceSide } from '../src/ble/provisioning.js';
import { aesCcmEncrypt } from '../src/ble/mesh-crypto.js';

// File FIFO asynchrone : représente une direction de communication entre le
// Provisioner (nous) et un device simulé, via Proxy PDU type Provisioning (§2/§4).
// Utilisée uniquement pour les tests : ne dépend d'aucun matériel BLE.
function createAsyncQueue() {
  const items = [];
  const waiters = [];
  return {
    push(value) {
      if (waiters.length) waiters.shift()(value);
      else items.push(value);
    },
    shift() {
      if (items.length) return Promise.resolve(items.shift());
      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}

function createLinkedTransports() {
  const toDevice = createAsyncQueue();
  const toProvisioner = createAsyncQueue();

  const provisionerTransport = {
    async send(type, params) { toDevice.push({ type, params }); },
    async receive(expectedType) {
      const { type, params } = await toProvisioner.shift();
      assert.equal(type, expectedType, `Provisioner attendait le type ${expectedType}, reçu ${type}`);
      return params;
    }
  };
  const deviceTransport = {
    async send(type, params) { toProvisioner.push({ type, params }); },
    async receive(expectedType) {
      const { type, params } = await toDevice.shift();
      assert.equal(type, expectedType, `Device attendait le type ${expectedType}, reçu ${type}`);
      return params;
    }
  };
  return { provisionerTransport, deviceTransport };
}

test('provisioning: le Provisioner et le device dérivent la même DeviceKey et échangent la NetKey correctement', async () => {
  const { provisionerTransport, deviceTransport } = createLinkedTransports();
  const netKey = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 7 + 1) & 0xff));
  const unicastAddress = 0x0002;

  const capabilities = {
    numElements: 1, algorithms: 0x0001, publicKeyType: 0x00, staticOobType: 0x00,
    outputOobSize: 0x00, outputOobAction: 0x0000, inputOobSize: 0x00, inputOobAction: 0x0000
  };

  const timeline = [];
  const originalSend = provisionerTransport.send.bind(provisionerTransport);
  provisionerTransport.send = async (type, params) => {
    timeline.push(type);
    return originalSend(type, params);
  };
  const [provisionerResult, deviceResult] = await Promise.all([
    runProvisioning({
      transport: provisionerTransport,
      netKey,
      keyIndex: 0,
      ivIndex: 0,
      unicastAddress,
      encryptProvisioningData: (...args) => {
        timeline.push('encrypt-data');
        return aesCcmEncrypt(...args);
      },
      onBeforeData: async (pending) => {
        timeline.push('journal');
        assert.equal(pending.authenticationMitmProtected, false);
      }
    }),
    simulateDeviceSide({ transport: deviceTransport, capabilities })
  ]);

  assert.deepEqual(provisionerResult.deviceKey, deviceResult.deviceKey);
  assert.equal(provisionerResult.numElements, 1);
  assert.deepEqual(deviceResult.provisioningData.netKey, netKey);
  assert.equal(deviceResult.provisioningData.unicastAddress, unicastAddress);
  assert.equal(deviceResult.provisioningData.keyIndex, 0);
  assert.equal(deviceResult.provisioningData.ivIndex, 0);
  assert.ok(timeline.indexOf('encrypt-data') < timeline.indexOf('journal'), 'le PDU Data doit être chiffré avant la journalisation');
  assert.ok(timeline.indexOf('journal') < timeline.indexOf(0x07), 'la DevKey doit être journalisée avant Provisioning Data');
  assert.equal(provisionerResult.authenticationMethod, 'no-oob');
  assert.equal(provisionerResult.authenticationMitmProtected, false);
});

test('provisioning No-OOB: une Confirmation corrompue est rejetée, sans revendiquer de protection MITM', async () => {
  const { provisionerTransport, deviceTransport } = createLinkedTransports();
  const netKey = Buffer.alloc(16, 0x42);

  // Device malveillant : répond avec une Confirmation aléatoire au lieu du vrai calcul.
  async function maliciousDeviceSide() {
    await deviceTransport.receive(0x00); // Invite
    const capabilitiesRaw = Buffer.from([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    await deviceTransport.send(0x01, capabilitiesRaw);
    await deviceTransport.receive(0x02); // Start
    await deviceTransport.receive(0x03); // Public Key provisioner
    const fakeKeyPair = (await import('../src/ble/mesh-crypto.js')).generateProvisioningKeyPair();
    await deviceTransport.send(0x03, fakeKeyPair.publicKeyXY);
    await deviceTransport.receive(0x05); // Confirmation provisioner
    const { randomBytes } = await import('../src/ble/mesh-crypto.js');
    await deviceTransport.send(0x05, randomBytes(16)); // Confirmation bidon
    await deviceTransport.receive(0x06); // Random provisioner
    await deviceTransport.send(0x06, randomBytes(16));
  }

  await assert.rejects(
    Promise.all([
      runProvisioning({ transport: provisionerTransport, netKey, keyIndex: 0, ivIndex: 0, unicastAddress: 2 }),
      maliciousDeviceSide()
    ]),
    /Confirmation cryptographique du device invalide/
  );
});

test('provisioning: refuse des Capabilities sans FIPS P-256 avant Start', async () => {
  const sent = [];
  const transport = {
    async send(type) { sent.push(type); },
    async receive(expectedType) {
      assert.equal(expectedType, 0x01);
      return Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
  };
  await assert.rejects(
    runProvisioning({ transport, netKey: Buffer.alloc(16), unicastAddress: 2 }),
    /FIPS P-256 non supporté/
  );
  assert.deepEqual(sent, [0x00], 'Start ne doit pas être envoyé avec des Capabilities incompatibles');
});
