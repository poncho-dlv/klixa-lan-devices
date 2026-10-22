import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshClient } from '../src/ble/mesh-client.js';
import { createEmptyMeshState, serializeMeshState } from '../src/ble/mesh-store.js';
import { deriveNetworkKeys, decryptNetworkPdu, encryptNetworkPdu } from '../src/ble/network-layer.js';
import {
  decodeLowerTransportUnsegmented,
  decodeSegmentHeader,
  decryptUpperTransportAccess,
  deriveAppKeyAid,
  encodeLowerTransportUnsegmented,
  encryptUpperTransportAccess,
  reassembleSegments,
  segmentUpperTransportPdu,
  UNSEGMENTED_MAX_ACCESS_LENGTH
} from '../src/ble/transport-layer.js';
import { createProxyPduReassembler, encodeProxyPdus, PROXY_PDU_TYPE } from '../src/ble/proxy-pdu.js';
import { simulateDeviceSide } from '../src/ble/provisioning.js';
import { decodeAccessOpcode, CONFIG_OPCODE, encodeConfigOpcode } from '../src/ble/config-messages.js';
import { VENDOR_SUBOPCODE_DATA } from '../src/ble/lq-protocol.js';

// Simulateur minimal de firmware RM75 : implémente le rôle "device" du provisioning
// (déjà couvert par simulateDeviceSide) PUIS le rôle "nœud mesh" côté Proxy — répond
// aux messages de configuration (§8) et aux commandes Lq (§9). Réutilise les mêmes
// couches pures (network-layer/transport-layer/proxy-pdu) que le mesh-client réel :
// c'est légitime ici car ce qui est testé est l'ORCHESTRATION de mesh-client.js (bon
// enchaînement, bon adressage, bon opcode), pas la crypto elle-même (déjà validée
// indépendamment par les autres suites de tests).
function createFakeLamp({
  deviceUuid,
  capabilities = { numElements: 1, algorithms: 1, publicKeyType: 0, staticOobType: 0, outputOobSize: 0, outputOobAction: 0, inputOobSize: 0, inputOobAction: 0 },
  vendorElementIndex = 0,
  dropFirstSegmentOnce = false,
  responseDelayMs = 0,
  closeDelayMs = 0
}) {
  const state = {
    provisioned: false,
    deviceKey: null,
    unicastAddress: null,
    netKey: null,
    appKey: null,
    boundModel: false,
    vendorElementIndex,
    proxyFilterAddresses: new Set(),
    readRequests: []
  };
  let onFragmentToProvisioner = null;
  let reassembler = null;

  function makeProvisioningTransport() {
    const incoming = [];
    const waiters = [];
    return {
      pushIncoming(msg) {
        if (waiters.length) waiters.shift()(msg);
        else incoming.push(msg);
      },
      async send(type, params) {
        const data = Buffer.concat([Buffer.from([type]), params]);
        for (const fragment of encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: 20 })) {
          onFragmentToProvisioner(fragment);
        }
      },
      async receive(expectedType) {
        const raw = incoming.length ? incoming.shift() : await new Promise((resolve) => waiters.push(resolve));
        const type = raw[0];
        if (type !== expectedType) throw new Error(`Device : type inattendu (attendu ${expectedType}, reçu ${type})`);
        return raw.subarray(1);
      }
    };
  }

  let provisioningTransport;

  return {
    deviceUuid,
    get kind() { return state.provisioned ? 'provisioned' : 'unprovisioned'; },
    get networkId() { return state.netKey ? deriveNetworkKeys(state.netKey).networkId : null; },

    // --- Lien de provisioning (0x1827) ---
    openProvisioningLink(onData) {
      onFragmentToProvisioner = onData;
      reassembler = createProxyPduReassembler();
      provisioningTransport = makeProvisioningTransport();

      simulateDeviceSide({ transport: provisioningTransport, capabilities }).then(({ deviceKey, provisioningData }) => {
        state.deviceKey = deviceKey;
        state.unicastAddress = provisioningData.unicastAddress;
        state.netKey = provisioningData.netKey;
        state.provisioned = true;
      }).catch((err) => { state.provisionError = err; });

      return {
        write: async (fragment) => {
          const msg = reassembler.feed(fragment);
          if (msg && msg.type === PROXY_PDU_TYPE.PROVISIONING) provisioningTransport.pushIncoming(msg.data);
        },
        close: async () => {
          state.provisioningClosing = true;
          if (closeDelayMs) await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
          state.provisioningClosing = false;
          state.provisioningCloseComplete = true;
        },
        maxAttributeValueLength: 20
      };
    },

    // --- Lien Proxy (0x1828) ---
    openProxyLink(onData) {
      const proxyReassembler = createProxyPduReassembler();
      const segmentBuffers = new Map();
      let closed = false;
      let replySeq = 500;

      const emitProxyPdu = (type, pdu) => {
        for (const fragment of encodeProxyPdus(type, pdu, { maxAttributeValueLength: 20 })) onData(fragment);
      };

      const sendNetworkPdu = (transportPdu, { ctl = false, seq = replySeq++, src = state.unicastAddress } = {}) => {
        const netKeys = deriveNetworkKeys(state.netKey);
        const pdu = encryptNetworkPdu({ ...netKeys, ivi: 0, ivIndex: 0, ctl, ttl: 5, seq, src, dst: 0x0001, transportPdu });
        emitProxyPdu(PROXY_PDU_TYPE.NETWORK, pdu);
      };

      const sendProxyFilterStatus = () => {
        const netKeys = deriveNetworkKeys(state.netKey);
        const status = Buffer.alloc(4);
        status[0] = 0x03;
        status[1] = state.proxyFilterType ?? 0;
        status.writeUInt16BE(state.proxyFilterAddresses.size, 2);
        const pdu = encryptNetworkPdu({
          ...netKeys,
          ivi: 0,
          ivIndex: 0,
          ctl: true,
          ttl: 0,
          seq: replySeq++,
          src: state.unicastAddress,
          dst: 0,
          transportPdu: status,
          nonceType: 'proxy'
        });
        emitProxyPdu(PROXY_PDU_TYPE.PROXY_CONFIGURATION, pdu);
      };

      const sendSegmentAck = (seqZero, segN, segments) => {
        let blockAck = 0;
        for (const segO of segments.keys()) blockAck = (blockAck | (2 ** segO)) >>> 0;
        const ack = Buffer.from([
          0x00,
          (seqZero >> 6) & 0x7f,
          (seqZero & 0x3f) << 2,
          (blockAck >>> 24) & 0xff,
          (blockAck >>> 16) & 0xff,
          (blockAck >>> 8) & 0xff,
          blockAck & 0xff
        ]);
        sendNetworkPdu(ack, { ctl: true });
        state.sentSegmentAcks = (state.sentSegmentAcks || 0) + 1;
      };

      const sendAccessReply = ({ accessPayload, key, keyType, src = state.unicastAddress }) => {
        const send = () => {
          const aid = keyType === 'app' ? deriveAppKeyAid(key) : 0;
          const enc = encryptUpperTransportAccess({ key, keyType, seq: replySeq, src, dst: 0x0001, ivIndex: 0, accessPayload });
          sendNetworkPdu(encodeLowerTransportUnsegmented({ akf: keyType === 'app', aid, upperTransportPdu: enc }), { seq: replySeq, src });
          replySeq += 1;
        };
        if (responseDelayMs) setTimeout(send, responseDelayMs); else send();
      };

      const handleAccessMessage = ({ akf, accessPayload, dst }) => {
        state.receivedAccessMessages = (state.receivedAccessMessages || 0) + 1;
        if (!akf) {
          // Message de configuration (DevKey)
          const { opcode, params } = decodeAccessOpcode(accessPayload);
          let replyPayload;
          if (opcode === CONFIG_OPCODE.COMPOSITION_DATA_GET) {
            // Compose une Composition Data Status volontairement > 11 octets pour
            // exercer la réassemblage en réception (segmentation, cf. transport-layer).
            // Page(1) + CID(2 LE) + PID(2 LE) + VID(2 LE) + CRPL(2 LE) + Features(2 LE) = 11 octets
            const header = Buffer.from([0x00, 0xf6, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            const elements = Array.from({ length: capabilities.numElements }, (_, index) => index === vendorElementIndex
              ? Buffer.from([0x00, 0x00, 0x00, 0x01, 0xf6, 0x03, 0x00, 0x10])
              : Buffer.from([0x00, 0x00, 0x00, 0x00]));
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.COMPOSITION_DATA_STATUS), header, ...elements]);
          } else if (opcode === CONFIG_OPCODE.APP_KEY_ADD) {
            state.appKey = params.subarray(3, 19);
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.APP_KEY_STATUS), Buffer.from([0x00]), params.subarray(0, 3)]);
          } else if (opcode === CONFIG_OPCODE.MODEL_APP_BIND) {
            state.boundElementAddress = params.readUInt16LE(0);
            state.boundModel = state.boundElementAddress === state.unicastAddress + vendorElementIndex;
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.MODEL_APP_STATUS), Buffer.from([0x00]), params.subarray(0, 8)]);
          } else if (opcode === 0x8049) {
            replyPayload = encodeConfigOpcode(0x804a);
          } else {
            return;
          }
          if (replyPayload.length > UNSEGMENTED_MAX_ACCESS_LENGTH) {
            const enc = encryptUpperTransportAccess({ key: state.deviceKey, keyType: 'device', seq: replySeq, src: state.unicastAddress, dst: 0x0001, ivIndex: 0, accessPayload: replyPayload });
            const seqZero = replySeq & 0x1fff;
            const segments = segmentUpperTransportPdu({ akf: false, aid: 0, seqZero, szmic: false, upperTransportPdu: enc });
            for (const seg of segments) { sendNetworkPdu(seg, { seq: replySeq }); replySeq += 1; }
            // Retransmission simulée du premier segment (comme un vrai firmware qui n'a
            // pas encore vu l'ack) : le mesh-client doit la ré-acquitter sans retraiter
            // le message (déduplication par segO + mémoire des messages complétés).
            sendNetworkPdu(segments[0], { seq: replySeq }); replySeq += 1;
          } else {
            sendAccessReply({ accessPayload: replyPayload, key: state.deviceKey, keyType: 'device' });
          }
          if (opcode === 0x8049) state.provisioned = false;
          return;
        }

        // Message applicatif confirmé SmallGoGo : [0x24][trame Lq].
        if (accessPayload[0] !== VENDOR_SUBOPCODE_DATA) return;
        const lqFrame = accessPayload.subarray(1);
        state.lastLqFrame = lqFrame;

        if ([0x31, 0x32, 0x43].includes(lqFrame[0])) state.readRequests.push(lqFrame[0]);
        if (lqFrame[0] === 0x43) {
          const values = [0x00, 0x00, 0x64, 0x64];
          const xor = values.reduce((a, b) => a ^ b, 0);
          const statusFrame = Buffer.from([3, values.length, xor, ...values]);
          sendAccessReply({ accessPayload: Buffer.concat([Buffer.from([VENDOR_SUBOPCODE_DATA]), statusFrame]), key: state.appKey, keyType: 'app', src: dst });
        } else if (lqFrame[0] === 0x31) {
          sendAccessReply({ accessPayload: Buffer.concat([Buffer.from([VENDOR_SUBOPCODE_DATA]), Buffer.from('08712311', 'ascii')]), key: state.appKey, keyType: 'app', src: dst });
        } else if (lqFrame[0] === 0x32) {
          sendAccessReply({ accessPayload: Buffer.concat([Buffer.from([VENDOR_SUBOPCODE_DATA]), Buffer.from('RM75_V1.2.3', 'ascii')]), key: state.appKey, keyType: 'app', src: dst });
        }
      };

      return {
        write: async (fragment) => {
          const msg = proxyReassembler.feed(fragment);
          if (!msg) return;
          const netKeys = deriveNetworkKeys(state.netKey);
          if (msg.type === PROXY_PDU_TYPE.PROXY_CONFIGURATION) {
            const decoded = decryptNetworkPdu({ ...netKeys, ivIndex: 0, pdu: msg.data, nonceType: 'proxy' });
            const opcode = decoded.transportPdu[0];
            if (opcode === 0x00) {
              state.proxyFilterType = decoded.transportPdu[1];
              state.proxyFilterAddresses.clear();
            } else if (opcode === 0x01) {
              for (let offset = 1; offset + 1 < decoded.transportPdu.length; offset += 2) {
                state.proxyFilterAddresses.add(decoded.transportPdu.readUInt16BE(offset));
              }
            }
            state.receivedProxyConfig = (state.receivedProxyConfig || 0) + 1;
            sendProxyFilterStatus();
            return;
          }
          if (msg.type !== PROXY_PDU_TYPE.NETWORK) return;
          const decoded = decryptNetworkPdu({ ...netKeys, ivIndex: 0, pdu: msg.data });
          if (decoded.dst < state.unicastAddress || decoded.dst >= state.unicastAddress + capabilities.numElements) return;
          // Messages de contrôle (CTL=1) : Segment Ack envoyé par le mesh-client après
          // réassemblage de notre Composition Data Status — un vrai firmware arrêterait
          // ses retransmissions ici ; rien à faire côté simulé.
          if (decoded.ctl) { state.receivedSegmentAcks = (state.receivedSegmentAcks || 0) + 1; return; }

          const seg = (decoded.transportPdu[0] >> 7) & 1;
          if (seg === 0) {
            const { akf, upperTransportPdu } = decodeLowerTransportUnsegmented(decoded.transportPdu);
            const keyType = akf ? 'app' : 'device';
            const key = akf ? state.appKey : state.deviceKey;
            const accessPayload = decryptUpperTransportAccess({ key, keyType, seq: decoded.seq, src: decoded.src, dst: decoded.dst, ivIndex: 0, encAccessPayload: upperTransportPdu });
            handleAccessMessage({ akf, accessPayload, dst: decoded.dst });
            return;
          }

          const header = decodeSegmentHeader(decoded.transportPdu);
          const key = `${header.seqZero}`;
          let buf = segmentBuffers.get(key);
          if (!buf) { buf = { segments: new Map(), seqAuth: (decoded.seq & ~0x1fff) | header.seqZero }; segmentBuffers.set(key, buf); }
          if (dropFirstSegmentOnce && !state.droppedFirstSegment && header.segO === 0) {
            state.droppedFirstSegment = true;
            return;
          }
          buf.segments.set(header.segO, header);
          if (header.segO === header.segN || buf.segments.size === header.segN + 1) {
            sendSegmentAck(header.seqZero, header.segN, buf.segments);
          }
          if (buf.segments.size === header.segN + 1) {
            segmentBuffers.delete(key);
            const { akf, upperTransportPdu } = reassembleSegments([...buf.segments.values()]);
            const keyType = akf ? 'app' : 'device';
            const key2 = akf ? state.appKey : state.deviceKey;
            const accessPayload = decryptUpperTransportAccess({ key: key2, keyType, seq: buf.seqAuth, src: decoded.src, dst: decoded.dst, ivIndex: 0, encAccessPayload: upperTransportPdu });
            handleAccessMessage({ akf, accessPayload, dst: decoded.dst });
          }
        },
        close: async () => {
          if (closeDelayMs) await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
          closed = true;
          state.proxyCloseCount = (state.proxyCloseCount || 0) + 1;
        },
        get connected() { return !closed && state.provisioned; },
        maxAttributeValueLength: 20
      };
    },

    _state: state
  };
}

test('mesh-client : découverte, provisioning, configuration et commande HSI de bout en bout (firmware simulé)', async () => {
  const lamp = createFakeLamp({
    deviceUuid: Buffer.alloc(16, 0x42),
    capabilities: { numElements: 2, algorithms: 1, publicKeyType: 0, staticOobType: 0, outputOobSize: 0, outputOobAction: 0, inputOobSize: 0, inputOobAction: 0 },
    vendorElementIndex: 1,
    dropFirstSegmentOnce: true,
    responseDelayMs: 5,
    closeDelayMs: 10
  });
  const persisted = [];
  let persistenceError = null;
  let advertisementScanCount = 0;
  let failNextProxyOpen = false;

  // getState()/persistState() doivent partager le MÊME objet mutable entre appels au
  // sein d'une opération (ex. ensureNetworkKeys puis addNode dans provision()).
  let liveState = createEmptyMeshState();
  const client = createMeshClient({
    getState: () => liveState,
    persistState: async (state) => {
      if (persistenceError) throw persistenceError;
      liveState = state;
      persisted.push(serializeMeshState(state));
    },
    scanForLampAdvertisements: async () => {
      advertisementScanCount += 1;
      if (lamp.kind === 'unprovisioned') {
        return [{
          // Simule la rotation de l'adresse privée entre le scan d'affichage et le
          // scan de connexion. Le Device UUID Mesh reste l'identité fiable.
          bleDeviceId: advertisementScanCount === 1 ? 'lamp-old-rpa' : 'lamp-new-rpa',
          kind: 'unprovisioned', deviceUuid: lamp.deviceUuid, device: lamp, rssi: -50, name: null
        }];
      }
      return [{ bleDeviceId: 'lamp-1', kind: 'provisioned', networkId: lamp.networkId, device: lamp, rssi: -50, name: null }];
    },
    openProvisioningConnection: async (device, { onData }) => device.openProvisioningLink(onData),
    openProxyConnection: async (device, { onData }) => {
      if (failNextProxyOpen) {
        failNextProxyOpen = false;
        throw new Error('connexion Proxy simulée en échec');
      }
      return device.openProxyLink(onData);
    },
    waitForProxyAdvertisement: async () => {
      assert.equal(lamp._state.provisioningClosing, false, 'la déconnexion PB-GATT doit être attendue avant le rescan Proxy');
      assert.equal(lamp._state.provisioningCloseComplete, true);
      return [{ bleDeviceId: 'lamp-1', kind: 'provisioned', device: lamp }];
    }
  });

  const discovered = await client.discover({ timeoutMs: 100 });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].kind, 'unprovisioned');

  const provisioned = await client.provision({
    bleDeviceId: 'lamp-old-rpa',
    deviceUuid: lamp.deviceUuid.toString('hex'),
    name: 'Lampe test'
  });
  assert.equal(provisioned.name, 'Lampe test');
  assert.equal(provisioned.provisioned, true);
  assert.equal(provisioned.configured, true);
  assert.equal(lamp._state.provisioned, true);
  assert.equal(lamp._state.boundModel, true);
  assert.equal(lamp._state.boundElementAddress, provisioned.unicastAddress + 1);
  assert.ok(lamp._state.appKey, 'AppKey doit avoir été transmise pendant la configuration');
  assert.ok(lamp._state.receivedSegmentAcks >= 2, 'la lampe doit avoir reçu un Segment Ack pour sa Composition Data Status ET pour sa retransmission');
  assert.ok(lamp._state.sentSegmentAcks >= 2, 'la lampe simulée doit acquitter puis faire retransmettre le segment manquant');
  assert.ok(lamp._state.receivedProxyConfig >= 2, 'Set Filter Type et Add Addresses doivent être envoyés');
  assert.deepEqual([...lamp._state.proxyFilterAddresses], [0x0001]);
  assert.ok(persisted.length >= 2, 'l\'état doit avoir été persisté (clés générées + nœud ajouté)');

  const [listed] = client.listNodes();
  assert.equal(listed.vendorElementAddress, provisioned.unicastAddress + 1);
  assert.equal(listed.configurationStatus, 'configured');
  assert.equal(listed.configurationPending, false);

  const results = await client.setHsi([provisioned.uuid], { hue: 0, sat: 100, intensity: 100 });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.ok(lamp._state.lastLqFrame, 'la lampe doit avoir reçu une trame Lq');
  assert.equal(lamp._state.lastLqFrame[0], 0x33); // opcode HSI
  assert.deepEqual([...lamp._state.lastLqFrame.subarray(3)], [0x00, 0x00, 0x64, 0x64]); // hue=0, sat=100, int=100

  const status = await client.readStatus(provisioned.uuid);
  assert.deepEqual(status, { type: 'hsi', hue: 0, sat: 0x64, intensity: 0x64 });

  const [statusConcurrent, capacityConcurrent] = await Promise.all([
    client.readStatus(provisioned.uuid),
    client.readCapacity(provisioned.uuid)
  ]);
  assert.equal(statusConcurrent.type, 'hsi');
  assert.equal(capacityConcurrent.battery, 87);
  assert.deepEqual(lamp._state.readRequests.slice(-2), [0x43, 0x31], 'les lectures du même nœud doivent rester sérialisées');

  await client.setPower([provisioned.uuid], { on: false, level: 50 });
  assert.equal(lamp._state.lastLqFrame.toString('hex'), '4202fcfc00', 'OFF doit primer sur level');

  // Fast-path de reconnexion : après une coupure de session, le dernier candidat
  // Proxy connu est retenté DIRECTEMENT, sans nouveau pré-scan de 8 s.
  const scansBeforeReconnect = advertisementScanCount;
  await client.stop();
  const reconnectResults = await client.setHsi([provisioned.uuid], { hue: 5, sat: 5, intensity: 5 });
  assert.equal(reconnectResults[0].ok, true);
  assert.equal(advertisementScanCount, scansBeforeReconnect, 'reconnexion directe attendue, sans nouveau scan');

  // Candidat mémorisé périmé (échec de connexion) : repli sur le scan complet, qui
  // doit aboutir sur le même réseau.
  await client.stop();
  failNextProxyOpen = true;
  const fallbackResults = await client.setHsi([provisioned.uuid], { hue: 6, sat: 6, intensity: 6 });
  assert.equal(fallbackResults[0].ok, true);
  assert.equal(advertisementScanCount, scansBeforeReconnect + 1, 'repli sur un scan complet après échec du candidat mémorisé');

  liveState.seqAllocatedUpTo = liveState.seq;
  persistenceError = new Error('réservation non durable');
  const writesBeforePersistenceFailure = lamp._state.receivedAccessMessages;
  const failedSends = await Promise.all([
    client.setHsi([provisioned.uuid], { hue: 10, sat: 10, intensity: 10 }),
    client.setHsi([provisioned.uuid], { hue: 20, sat: 20, intensity: 20 })
  ]);
  assert.equal(failedSends[0][0].ok, false);
  assert.equal(failedSends[1][0].ok, false);
  assert.equal(lamp._state.receivedAccessMessages, writesBeforePersistenceFailure, 'aucune PDU ne doit partir après échec de réservation SEQ');
  persistenceError = null;

  const forgotten = await client.forget({ uuid: provisioned.uuid });
  assert.deepEqual(forgotten, { removed: true, reset: true, forceLocal: false });
  assert.equal(lamp._state.provisioned, false, 'Node Reset doit précéder la suppression locale');
  assert.deepEqual(client.listNodes(), []);
  assert.ok(lamp._state.proxyCloseCount >= 2, 'les fermetures Proxy asynchrones doivent être attendues');

  await client.stop();
});

test('mesh-client : discover() masque une lampe déjà appairée même si elle émet encore un beacon non-provisionné', async () => {
  const pairedUuid = Buffer.alloc(16, 0x99);
  const state = createEmptyMeshState();
  state.nodes.push({
    uuid: pairedUuid.toString('hex'),
    name: 'Déjà appairée',
    unicastAddress: 1,
    elementCount: 1,
    vendorElementAddress: 1,
    deviceKey: '44'.repeat(16),
    configurationStatus: 'configured'
  });

  const client = createMeshClient({
    getState: () => state,
    persistState: async () => {},
    scanForLampAdvertisements: async () => [
      { bleDeviceId: 'stale-unprovisioned-beacon', kind: 'unprovisioned', deviceUuid: pairedUuid, rssi: -40, name: null },
      { bleDeviceId: 'genuinely-new-lamp', kind: 'unprovisioned', deviceUuid: Buffer.alloc(16, 0x11), rssi: -60, name: null }
    ]
  });

  const discovered = await client.discover({ timeoutMs: 50 });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].bleDeviceId, 'genuinely-new-lamp');
});

test('mesh-client : réconcilie un stale local puis annule proprement un échec garanti avant Provisioning Data', async () => {
  const uuid = 'ab'.repeat(16);
  let state = createEmptyMeshState();
  state.netKey = '11'.repeat(16);
  state.appKey = '22'.repeat(16);
  state.nextUnicastAddress = 3;
  state.pendingProvisioning = {
    uuid,
    name: 'Ancienne tentative',
    unicastAddress: 2,
    elementCount: 1,
    vendorElementAddress: 2,
    deviceKey: '33'.repeat(16),
    phase: 'data-ready'
  };
  state.nodes.push({
    ...state.pendingProvisioning,
    configurationStatus: 'provisioning-uncertain',
    configurationError: 'Unknown cipher'
  });
  const persisted = [];
  let connectionClosed = false;

  const client = createMeshClient({
    getState: () => state,
    persistState: async (nextState) => {
      state = nextState;
      persisted.push(JSON.parse(serializeMeshState(nextState)));
    },
    scanForLampAdvertisements: async () => [{
      bleDeviceId: 'lamp-pre-data',
      kind: 'unprovisioned',
      deviceUuid: Buffer.from(uuid, 'hex'),
      device: {},
      rssi: -45,
      name: null
    }],
    openProvisioningConnection: async () => ({
      maxAttributeValueLength: 20,
      write: async () => {},
      close: async () => { connectionClosed = true; }
    }),
    openProxyConnection: async () => { throw new Error('inutilisé'); },
    waitForProxyAdvertisement: async () => [],
    runProvisioningFn: async ({ unicastAddress, onBeforeData }) => {
      assert.deepEqual(state.nodes, [], 'le beacon unprovisioned doit supprimer le stale node avant le handshake');
      assert.equal(state.pendingProvisioning, null);
      assert.deepEqual(persisted.at(-1).nodes, [], 'la réconciliation doit être durable avant le handshake');
      assert.equal(persisted.at(-1).pendingProvisioning, null);
      const allocatedAddress = unicastAddress({ numElements: 1 });
      assert.equal(allocatedAddress, 3);
      await onBeforeData({
        deviceKey: Buffer.alloc(16, 0x44),
        unicastAddress: allocatedAddress,
        numElements: 1
      });
      const error = new Error('Unknown cipher');
      error.provisioningDataMayHaveBeenSent = false;
      throw error;
    }
  });

  await assert.rejects(
    client.provision({ bleDeviceId: 'lamp-pre-data', deviceUuid: uuid, name: 'Pré-Data' }),
    /Unknown cipher/
  );

  assert.equal(connectionClosed, true);
  assert.equal(state.pendingProvisioning, null);
  assert.equal(state.nextUnicastAddress, 3, 'l\'allocation pré-Data doit être restaurée en mémoire');
  assert.deepEqual(state.nodes, []);
  assert.equal(persisted.at(-1).pendingProvisioning, null, 'le nettoyage du journal doit être durable');
  assert.deepEqual(client.listNodes(), []);
});

test('mesh-client : forceLocal oublie explicitement un nœud perdu sans tentative radio', async () => {
  const state = createEmptyMeshState();
  state.netKey = Buffer.alloc(16, 1).toString('hex');
  state.appKey = Buffer.alloc(16, 2).toString('hex');
  state.nodes.push({
    uuid: 'lost',
    name: 'Perdue',
    unicastAddress: 2,
    vendorElementAddress: 2,
    elementCount: 1,
    deviceKey: Buffer.alloc(16, 3).toString('hex'),
    configurationStatus: 'configured'
  });
  let scans = 0;
  const client = createMeshClient({
    getState: () => state,
    persistState: async () => {},
    scanForLampAdvertisements: async () => { scans += 1; throw new Error('radio indisponible'); },
    openProxyConnection: async () => { throw new Error('ne doit pas être appelée'); },
    waitForProxyAdvertisement: async () => []
  });

  const result = await client.forget({ uuid: 'lost', forceLocal: true });
  assert.deepEqual(result, { removed: true, reset: false, forceLocal: true });
  assert.equal(scans, 0);
  assert.deepEqual(state.nodes, []);
});

test('mesh-client : forget échoue avant Node Reset si le backend durable est indisponible', async () => {
  const state = createEmptyMeshState();
  state.netKey = Buffer.alloc(16, 1).toString('hex');
  state.appKey = Buffer.alloc(16, 2).toString('hex');
  state.nodes.push({
    uuid: 'aa'.repeat(16),
    name: 'Persistée',
    unicastAddress: 2,
    vendorElementAddress: 2,
    elementCount: 1,
    deviceKey: Buffer.alloc(16, 3).toString('hex'),
    configurationStatus: 'configured'
  });
  let scans = 0;
  const client = createMeshClient({
    getState: () => state,
    persistState: async () => { throw new Error('stockage indisponible'); },
    scanForLampAdvertisements: async () => { scans += 1; return []; },
    openProxyConnection: async () => { throw new Error('ne doit pas être appelée'); },
    waitForProxyAdvertisement: async () => []
  });

  await assert.rejects(client.forget({ uuid: 'aa'.repeat(16) }), /stockage indisponible/);
  assert.equal(scans, 0, 'aucune opération radio irréversible avant le preflight durable');
  assert.equal(state.nodes.length, 1);
});

test('mesh-client : conserve le journal si la finalisation locale échoue après Node Reset', async () => {
  const uuid = 'dd'.repeat(16);
  const lamp = createFakeLamp({ deviceUuid: Buffer.from(uuid, 'hex') });
  const state = createEmptyMeshState();
  state.netKey = Buffer.alloc(16, 1).toString('hex');
  state.appKey = Buffer.alloc(16, 2).toString('hex');
  state.seqAllocatedUpTo = 100;
  state.nodes.push({
    uuid,
    name: 'Journalisée',
    unicastAddress: 2,
    vendorElementAddress: 2,
    elementCount: 1,
    deviceKey: Buffer.alloc(16, 3).toString('hex'),
    configurationStatus: 'configured'
  });
  lamp._state.provisioned = true;
  lamp._state.unicastAddress = 2;
  lamp._state.netKey = Buffer.from(state.netKey, 'hex');
  lamp._state.appKey = Buffer.from(state.appKey, 'hex');
  lamp._state.deviceKey = Buffer.from(state.nodes[0].deviceKey, 'hex');

  let persistenceCalls = 0;
  let identityOpenAttempts = 0;
  const identityOnlyCandidate = { openProxyLink: () => { identityOpenAttempts += 1; throw new Error('mauvais candidat'); } };
  const client = createMeshClient({
    getState: () => state,
    persistState: async () => {
      persistenceCalls += 1;
      if (persistenceCalls === 3) throw new Error('disque plein');
    },
    scanForLampAdvertisements: async () => [
      { kind: 'provisioned', networkId: null, device: identityOnlyCandidate },
      { kind: 'provisioned', networkId: lamp.networkId.toString('hex'), device: lamp }
    ],
    openProxyConnection: async (device, { onData }) => device.openProxyLink(onData),
    waitForProxyAdvertisement: async () => []
  });

  await assert.rejects(client.forget({ uuid }), { code: 'NODE_RESET_LOCAL_FINALIZE_FAILED' });
  assert.equal(identityOpenAttempts, 0, 'un Network ID exact doit être prioritaire sur Node Identity');
  assert.equal(lamp._state.provisioned, false, 'le reset distant a bien eu lieu');
  assert.equal(state.nodes.length, 1, 'le nœud reste visible tant que la finalisation durable a échoué');
  assert.equal(state.pendingNodeReset.uuid, uuid, 'le journal permet de reprendre la finalisation au redémarrage');
  assert.equal(client.listNodes()[0].resetPending, true);
  await assert.rejects(client.setPower([uuid], { on: true }), /Node Reset en attente/);
});

test('mesh-client : un reset en attente ne peut pas être écrasé par un autre oubli', async () => {
  const firstUuid = 'aa'.repeat(16);
  const secondUuid = 'bb'.repeat(16);
  const state = createEmptyMeshState();
  state.netKey = Buffer.alloc(16, 1).toString('hex');
  state.appKey = Buffer.alloc(16, 2).toString('hex');
  state.nodes.push(
    {
      uuid: firstUuid, name: 'Premier', unicastAddress: 2, vendorElementAddress: 2,
      elementCount: 1, deviceKey: Buffer.alloc(16, 3).toString('hex'), configurationStatus: 'configured'
    },
    {
      uuid: secondUuid, name: 'Second', unicastAddress: 3, vendorElementAddress: 3,
      elementCount: 1, deviceKey: Buffer.alloc(16, 4).toString('hex'), configurationStatus: 'configured'
    }
  );
  state.pendingNodeReset = { uuid: firstUuid, requestedAt: '2026-07-20T10:00:00.000Z' };
  let scans = 0;
  const client = createMeshClient({
    getState: () => state,
    persistState: async () => {},
    scanForLampAdvertisements: async () => { scans += 1; return []; },
    openProxyConnection: async () => { throw new Error('ne doit pas être appelée'); },
    waitForProxyAdvertisement: async () => []
  });

  await assert.rejects(client.forget({ uuid: secondUuid }), { code: 'SMALLRIG_NODE_RESET_PENDING' });
  assert.equal(scans, 0);
  const forced = await client.forget({ uuid: secondUuid, forceLocal: true });
  assert.deepEqual(forced, { removed: true, reset: false, forceLocal: true });
  assert.equal(state.pendingNodeReset.uuid, firstUuid, 'l\'intention de reset du premier nœud doit rester durable');
  assert.deepEqual(state.nodes.map((node) => node.uuid), [firstUuid]);
});
