// Orchestrateur mesh : combine crypto, network-layer, transport-layer, proxy-pdu,
// provisioning et lq-protocol par-dessus le transport BLE réel (ble-transport.js) pour
// offrir une API haut niveau — scan, provisioning, configuration, envoi de commandes,
// lecture d'état — consommée par index.js (les commandes `smallrig.*`).
//
// [Couche la moins testable en CI] Un firmware RM75 simulé couvre le parcours complet
// (provisioning, configuration, commandes et reprises), mais la validation radio du
// correctif GATT reste nécessaire sur une lampe physique.

import { createLogger } from '../logger.js';
import {
  CONFIG_OPCODE,
  decodeAccessOpcode,
  decodeAppKeyStatus,
  decodeModelAppStatus,
  encodeAppKeyAdd,
  encodeCompositionDataGet,
  encodeModelAppBind,
  parseCompositionDataPage0
} from './config-messages.js';
import {
  decryptNetworkPdu,
  deriveNetworkKeys,
  encryptNetworkPdu
} from './network-layer.js';
import {
  createProxyPduReassembler,
  encodeProxyPdus,
  PROXY_PDU_TYPE
} from './proxy-pdu.js';
import { runProvisioning } from './provisioning.js';
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
} from './transport-layer.js';
import {
  buildVendorAccessPayload,
  decodeCapacity,
  decodeStatus,
  decodeVersion,
  encodeCapacityRead,
  encodeCct,
  encodeFx,
  encodeHsi,
  encodeLumLevel,
  encodeLumOff,
  encodeLumOn,
  encodeRgbw,
  encodeStatusRead,
  encodeVersionRead,
  stripAtPrefix,
  VENDOR_SUBOPCODE_DATA
} from './lq-protocol.js';
import {
  addNode,
  allocateUnicastAddress,
  appKeyBuffer,
  clearPendingProvisioning,
  ensureNetworkKeys,
  findNode,
  netKeyBuffer,
  nextSeq,
  nodeDeviceKeyBuffer,
  removeNode,
  setPendingProvisioning
} from './mesh-store.js';

const log = createLogger('smallrig-mesh');

// MESH_MODEL_DATATRANS_SERVER : ModelID 0x1000, CID 0x03F6 — corrigé depuis la
// Composition Data réelle d'une RM75 (§12 RM75_SPEC_DEV.md). L'hypothèse initiale
// (CID 0x005D/Realtek, ModelID 0x0004) ne correspond à aucun modèle annoncé par le
// matériel : le CID 0x005D n'y porte que des modèles génériques de la stack Realtek
// (ModelID 0x0000/0x0001) ; le vrai modèle de contrôle Lq est déclaré sous le CID
// propre au fabricant (0x03F6), identique au CID d'en-tête de la Composition Data.
const VENDOR_MODEL_ID = 0x100003f6;
const DEFAULT_TTL = 5;
const CONFIG_RESPONSE_TIMEOUT_MS = 8000;
const COMMAND_RESPONSE_TIMEOUT_MS = 5000;
const SEGMENT_ACK_TIMEOUT_MS = 1200;
const SEGMENT_SEND_ATTEMPTS = 3;
const PROXY_FILTER_TIMEOUT_MS = 3000;
const REPLAY_WINDOW = 8192;
const PROXY_FILTER_TYPE_ACCEPTLIST = 0x00;
const PROXY_CONFIG_OPCODE = { SET_FILTER_TYPE: 0x00, ADD_ADDRESSES: 0x01, FILTER_STATUS: 0x03 };
const CONFIG_NODE_RESET_OPCODE = 0x8049;
const CONFIG_NODE_RESET_STATUS_OPCODE = 0x804a;

function createAsyncQueue() {
  const items = [];
  const waiters = [];
  return {
    push(value) {
      if (waiters.length) {
        const waiter = waiters.shift();
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else items.push(value);
    },
    async shift(timeoutMs) {
      if (items.length) return items.shift();
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiters.push(waiter);
        if (timeoutMs) {
          waiter.timer = setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx !== -1) {
              waiters.splice(idx, 1);
              reject(new Error('Délai dépassé en attente de réponse'));
            }
          }, timeoutMs);
          waiter.timer.unref?.();
        }
      });
    },
    clear() {
      items.splice(0, items.length);
    }
  };
}

// Une session Proxy GATT ouverte vers N'IMPORTE QUEL nœud du mesh suffit à atteindre
// TOUS les nœuds (relayage mesh standard, cf. RM75_SPEC_DEV.md §10) : on ne maintient
// qu'une seule connexion active à la fois, réutilisée pour toutes les commandes.
function createProxySession({ conn, netKeys, ivIndex, provisionerAddress, seqAllocatorFactory }) {
  const reassembler = createProxyPduReassembler();
  const segmentBuffers = new Map();
  const completedSegmented = new Map();
  const pendingSegmentAcks = new Map();
  const replayBySource = new Map();
  const inbox = new Map();
  const proxyConfigInbox = createAsyncQueue();
  // Une seule file couvre allocation SEQ -> persistance du high-water -> chiffrement ->
  // tous les segments/fragments. Aucun await de persistance ne peut donc inverser deux
  // numéros de séquence concurrents.
  let sendChain = Promise.resolve();
  let persistenceFailure = null;

  function enqueueSend(task) {
    const queued = sendChain.then(task);
    sendChain = queued.catch(() => { /* l'erreur reste propagée via queued */ });
    return queued;
  }

  function inboxFor(src) {
    if (!inbox.has(src)) inbox.set(src, createAsyncQueue());
    return inbox.get(src);
  }

  function clearInbox(src) {
    inboxFor(src).clear();
  }

  async function allocateSequence(allocator) {
    if (persistenceFailure) throw persistenceFailure;
    const previousSeq = allocator.state.seq;
    const previousHighWater = allocator.state.seqAllocatedUpTo;
    const allocated = nextSeq(allocator.state, allocator.blockSize);
    if (allocated.crossedBoundary && allocator.onPersistNeeded) {
      try {
        await allocator.onPersistNeeded();
      } catch (err) {
        // La file est exclusive : restaurer le compteur est sûr, puis condamner cette
        // session afin qu'aucun envoi suivant n'utilise une réservation non durable.
        allocator.state.seq = previousSeq;
        allocator.state.seqAllocatedUpTo = previousHighWater;
        persistenceFailure = err;
        throw err;
      }
    }
    return allocated.seq;
  }

  async function writeProxyPduNow(type, data) {
    const fragments = encodeProxyPdus(type, data, { maxAttributeValueLength: conn.maxAttributeValueLength });
    for (const fragment of fragments) await conn.write(fragment);
  }

  function acceptNetworkSequence({ src, seq }) {
    let replay = replayBySource.get(src);
    if (!replay) {
      replay = { highest: -1, seen: new Set() };
      replayBySource.set(src, replay);
    }
    if (replay.seen.has(seq) || seq < replay.highest - REPLAY_WINDOW) return false;
    replay.seen.add(seq);
    replay.highest = Math.max(replay.highest, seq);
    if (replay.seen.size > 256) {
      const floor = replay.highest - REPLAY_WINDOW;
      for (const value of replay.seen) if (value < floor) replay.seen.delete(value);
    }
    return true;
  }

  function seqAuthFrom(seq, seqZero) {
    let auth = (seq & ~0x1fff) | seqZero;
    if (auth > seq) auth -= 0x2000;
    return auth;
  }

  function rememberCompleted(key, segN) {
    const now = Date.now();
    for (const [oldKey, value] of completedSegmented) {
      if (now - value.createdAt > 30000) completedSegmented.delete(oldKey);
    }
    completedSegmented.set(key, { segN, createdAt: now });
    if (completedSegmented.size > 32) completedSegmented.delete(completedSegmented.keys().next().value);
  }

  function buildSegmentAck({ seqZero, segN }) {
    const blockAck = (segN >= 31 ? 0xffffffff : (2 ** (segN + 1)) - 1) >>> 0;
    return Buffer.from([
      0x00,
      (seqZero >> 6) & 0x7f,
      (seqZero & 0x3f) << 2,
      (blockAck >>> 24) & 0xff,
      (blockAck >>> 16) & 0xff,
      (blockAck >>> 8) & 0xff,
      blockAck & 0xff
    ]);
  }

  function notifySegmentAck(decoded) {
    const bytes = decoded.transportPdu;
    if (bytes.length < 7 || (bytes[0] & 0x7f) !== 0x00) return;
    const seqZero = ((bytes[1] & 0x7f) << 6) | (bytes[2] >> 2);
    const tracker = pendingSegmentAcks.get(`${decoded.src}:${seqZero}`);
    if (!tracker) return;
    tracker.receivedAck = true;
    tracker.blockAck = (tracker.blockAck | bytes.readUInt32BE(3)) >>> 0;
    for (const resolve of tracker.waiters.splice(0)) resolve();
  }

  function waitForSegmentAck(tracker, timeoutMs) {
    if ((tracker.blockAck & tracker.fullMask) === tracker.fullMask) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const index = tracker.waiters.indexOf(onAck);
        if (index !== -1) tracker.waiters.splice(index, 1);
        if (error) reject(error); else resolve();
      };
      const onAck = () => finish();
      const timer = setTimeout(() => finish(new Error('Segment Ack non reçu')), timeoutMs);
      tracker.waiters.push(onAck);
    });
  }

  async function sendSegmentAck({ dst, seqZero, segN }) {
    if (!seqAllocatorFactory) return;
    try {
      await enqueueSend(async () => {
        const allocator = seqAllocatorFactory();
        const seq = await allocateSequence(allocator);
        const networkPdu = encryptNetworkPdu({
          ...netKeys,
          ivi: ivIndex & 1,
          ivIndex,
          ctl: true,
          ttl: DEFAULT_TTL,
          seq,
          src: provisionerAddress,
          dst,
          transportPdu: buildSegmentAck({ seqZero, segN })
        });
        await writeProxyPduNow(PROXY_PDU_TYPE.NETWORK, networkPdu);
      });
    } catch (err) {
      log.warn('Envoi du Segment Ack échoué (non bloquant)', err.message);
    }
  }

  function handleNetworkPdu(pdu) {
    let decoded;
    try {
      decoded = decryptNetworkPdu({ ...netKeys, ivIndex, pdu });
    } catch (err) {
      if (err.code !== 'UNKNOWN_NID') log.warn('Network PDU ignoré (déchiffrement)', err.message);
      return;
    }
    if (decoded.dst !== provisionerAddress) return;
    if (decoded.ctl) {
      if (!acceptNetworkSequence(decoded)) return;
      notifySegmentAck(decoded);
      return;
    }

    const seg = (decoded.transportPdu[0] >> 7) & 1;
    if (seg === 0) {
      if (!acceptNetworkSequence(decoded)) return;
      const { akf, aid, upperTransportPdu } = decodeLowerTransportUnsegmented(decoded.transportPdu);
      inboxFor(decoded.src).push({ seq: decoded.seq, akf, aid, szmic: false, upperTransportPdu });
      return;
    }

    const header = decodeSegmentHeader(decoded.transportPdu);
    const key = `${decoded.src}:${header.seqZero}`;
    const completed = completedSegmented.get(key);
    if (completed && Date.now() - completed.createdAt <= 30000) {
      // Ré-acquitter même une retransmission bit-à-bit (même Network SEQ) : elle ne
      // sera jamais remise dans l'inbox, mais indique que notre ACK précédent est perdu.
      void sendSegmentAck({ dst: decoded.src, seqZero: header.seqZero, segN: completed.segN });
      return;
    }
    if (!acceptNetworkSequence(decoded)) return;

    let buffer = segmentBuffers.get(key);
    if (!buffer) {
      for (const [staleKey, stale] of segmentBuffers) {
        if (Date.now() - stale.createdAt > 15000) segmentBuffers.delete(staleKey);
      }
      buffer = { segments: new Map(), seqAuth: seqAuthFrom(decoded.seq, header.seqZero), createdAt: Date.now() };
      segmentBuffers.set(key, buffer);
    }
    buffer.segments.set(header.segO, header);
    if (buffer.segments.size !== header.segN + 1) return;

    try {
      const { akf, aid, szmic, upperTransportPdu } = reassembleSegments([...buffer.segments.values()]);
      segmentBuffers.delete(key);
      rememberCompleted(key, header.segN);
      void sendSegmentAck({ dst: decoded.src, seqZero: header.seqZero, segN: header.segN });
      inboxFor(decoded.src).push({ seq: buffer.seqAuth, akf, aid, szmic, upperTransportPdu });
    } catch (err) {
      segmentBuffers.delete(key);
      log.warn('Réassemblage de segments échoué', err.message);
    }
  }

  function handleProxyConfigurationPdu(pdu) {
    try {
      const decoded = decryptNetworkPdu({ ...netKeys, ivIndex, pdu, nonceType: 'proxy' });
      if (!decoded.ctl || decoded.ttl !== 0 || decoded.dst !== 0x0000 || !acceptNetworkSequence(decoded)) return;
      proxyConfigInbox.push(decoded.transportPdu);
    } catch (err) {
      if (err.code !== 'UNKNOWN_NID') log.warn('Proxy Configuration PDU ignoré', err.message);
    }
  }

  function feed(bytes) {
    try {
      const msg = reassembler.feed(bytes);
      if (!msg) return;
      if (msg.type === PROXY_PDU_TYPE.NETWORK) handleNetworkPdu(msg.data);
      else if (msg.type === PROXY_PDU_TYPE.PROXY_CONFIGURATION) handleProxyConfigurationPdu(msg.data);
    } catch (err) {
      log.warn('Proxy PDU ignoré', err.message);
    }
  }

  async function sendProxyConfigurationNow(transportPdu, allocator) {
    const seq = await allocateSequence(allocator);
    const pdu = encryptNetworkPdu({
      ...netKeys,
      ivi: ivIndex & 1,
      ivIndex,
      ctl: true,
      ttl: 0,
      seq,
      src: provisionerAddress,
      dst: 0x0000,
      transportPdu,
      nonceType: 'proxy'
    });
    await writeProxyPduNow(PROXY_PDU_TYPE.PROXY_CONFIGURATION, pdu);
    const status = await proxyConfigInbox.shift(PROXY_FILTER_TIMEOUT_MS);
    if (status.length < 4 || status[0] !== PROXY_CONFIG_OPCODE.FILTER_STATUS) {
      throw new Error('Proxy Filter Status invalide ou inattendu');
    }
    return { filterType: status[1], listSize: status.readUInt16BE(2) };
  }

  async function configureProxyFilter(addresses = [provisionerAddress]) {
    if (!seqAllocatorFactory) throw new Error('Allocateur SEQ absent pour configurer le Proxy Filter');
    return enqueueSend(async () => {
      proxyConfigInbox.clear();
      const allocator = seqAllocatorFactory();
      let status = await sendProxyConfigurationNow(
        Buffer.from([PROXY_CONFIG_OPCODE.SET_FILTER_TYPE, PROXY_FILTER_TYPE_ACCEPTLIST]),
        allocator
      );
      if (status.filterType !== PROXY_FILTER_TYPE_ACCEPTLIST) throw new Error('Le Proxy a refusé le filtre acceptlist');
      const uniqueAddresses = [...new Set(addresses)].filter((address) => Number.isInteger(address) && address > 0 && address <= 0x7fff);
      if (uniqueAddresses.length) {
        const params = Buffer.alloc(1 + uniqueAddresses.length * 2);
        params[0] = PROXY_CONFIG_OPCODE.ADD_ADDRESSES;
        uniqueAddresses.forEach((address, index) => params.writeUInt16BE(address, 1 + index * 2));
        status = await sendProxyConfigurationNow(params, allocator);
        if (status.filterType !== PROXY_FILTER_TYPE_ACCEPTLIST
            || status.listSize !== uniqueAddresses.length) {
          throw new Error('Le Proxy n\'a pas appliqué la liste d\'adresses demandée');
        }
      }
      return status;
    });
  }

  async function send({ ttl = DEFAULT_TTL, src, dst, key, keyType, aid, accessPayload }) {
    return enqueueSend(async () => {
      if (!seqAllocatorFactory) throw new Error('Allocateur SEQ absent');
      const seqAllocator = seqAllocatorFactory();
      const firstSeq = await allocateSequence(seqAllocator);
      const upperTransportPdu = encryptUpperTransportAccess({ key, keyType, seq: firstSeq, src, dst, ivIndex, accessPayload });

      if (accessPayload.length <= UNSEGMENTED_MAX_ACCESS_LENGTH) {
        const transportPdu = encodeLowerTransportUnsegmented({ akf: keyType === 'app', aid, upperTransportPdu });
        const networkPdu = encryptNetworkPdu({ ...netKeys, ivi: ivIndex & 1, ivIndex, ctl: false, ttl, seq: firstSeq, src, dst, transportPdu });
        await writeProxyPduNow(PROXY_PDU_TYPE.NETWORK, networkPdu);
        return;
      }

      const seqZero = firstSeq & 0x1fff;
      const segments = segmentUpperTransportPdu({ akf: keyType === 'app', aid, seqZero, szmic: false, upperTransportPdu });
      const fullMask = (segments.length >= 32 ? 0xffffffff : (2 ** segments.length) - 1) >>> 0;
      const tracker = { blockAck: 0, fullMask, receivedAck: false, waiters: [] };
      const trackerKey = `${dst}:${seqZero}`;
      pendingSegmentAcks.set(trackerKey, tracker);
      try {
        for (let attempt = 1; attempt <= SEGMENT_SEND_ATTEMPTS; attempt++) {
          for (let index = 0; index < segments.length; index++) {
            if ((tracker.blockAck & (2 ** index)) !== 0) continue;
            const seq = attempt === 1 && index === 0 ? firstSeq : await allocateSequence(seqAllocator);
            const networkPdu = encryptNetworkPdu({
              ...netKeys,
              ivi: ivIndex & 1,
              ivIndex,
              ctl: false,
              ttl,
              seq,
              src,
              dst,
              transportPdu: segments[index]
            });
            await writeProxyPduNow(PROXY_PDU_TYPE.NETWORK, networkPdu);
          }
          if ((tracker.blockAck & fullMask) === fullMask) return;
          try {
            await waitForSegmentAck(tracker, SEGMENT_ACK_TIMEOUT_MS);
          } catch (_err) {
            if (attempt === SEGMENT_SEND_ATTEMPTS) {
              throw new Error(`Message mesh segmenté non acquitté après ${SEGMENT_SEND_ATTEMPTS} essais`);
            }
          }
          if (tracker.receivedAck && tracker.blockAck === 0) throw new Error('Message mesh segmenté annulé par le nœud');
          if ((tracker.blockAck & fullMask) === fullMask) return;
        }
      } finally {
        pendingSegmentAcks.delete(trackerKey);
      }
    });
  }

  async function receiveFrom(src, { timeoutMs = COMMAND_RESPONSE_TIMEOUT_MS } = {}) {
    const msg = await inboxFor(src).shift(timeoutMs);
    return {
      seq: msg.seq,
      upperTransportPdu: msg.upperTransportPdu,
      szmic: Boolean(msg.szmic),
      keyType: msg.akf ? 'app' : 'device',
      aid: msg.aid
    };
  }

  return {
    feed,
    send,
    receiveFrom,
    clearInbox,
    configureProxyFilter,
    get connected() { return !persistenceFailure && conn.connected; },
    close: () => conn.close()
  };
}

export function createMeshClient({
  getState,
  persistState,
  scanForLampAdvertisements,
  // Scan utilisé UNIQUEMENT par discover() (bouton "Scanner" de l'UI, affichage pur —
  // pas de connexion GATT derrière). Peut être isolé dans un processus séparé
  // (cf. ble-transport.js#scanForLampAdvertisements côté isolé) sans casser
  // provision()/ensureProxySession(), qui ont besoin d'un handle `device` réel pour se
  // connecter et continuent donc à utiliser `scanForLampAdvertisements` (in-process).
  // Retombe sur `scanForLampAdvertisements` si non fourni (rétrocompatible).
  scanForDisplay,
  openProvisioningConnection,
  openProxyConnection,
  waitForProxyAdvertisement,
  runProvisioningFn = runProvisioning,
  seqBlockSize = 100,
  provisionerAddress: forcedProvisionerAddress
}) {
  const scanForDisplayFn = scanForDisplay || scanForLampAdvertisements;
  let proxySession = null;
  let proxyConn = null;
  const nodeResponseChains = new Map();
  let operationChain = Promise.resolve();

  function enqueueOperation(task) {
    const queued = operationChain.then(task);
    operationChain = queued.catch(() => {});
    return queued;
  }

  function seqAllocator() {
    const state = getState();
    return { state, blockSize: seqBlockSize, onPersistNeeded: persistState ? () => persistState(state) : null };
  }

  function netKeysFor(state) {
    return deriveNetworkKeys(netKeyBuffer(state));
  }

  function withNodeResponseLock(address, task) {
    const previous = nodeResponseChains.get(address) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    nodeResponseChains.set(address, current.catch(() => {}));
    return current;
  }

  async function receiveAccessMatching(session, {
    source,
    destination,
    key,
    expectedKeyType,
    expectedAid,
    timeoutMs,
    match
  }) {
    const deadline = Date.now() + timeoutMs;
    let lastMismatch;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await session.receiveFrom(source, { timeoutMs: remaining });
      if (message.keyType !== expectedKeyType) {
        lastMismatch = `type de clé ${message.keyType}`;
        continue;
      }
      if (expectedKeyType === 'app' && message.aid !== expectedAid) {
        lastMismatch = `AID ${message.aid}`;
        continue;
      }
      try {
        const accessPayload = decryptUpperTransportAccess({
          key,
          keyType: message.keyType,
          aszmic: message.szmic,
          seq: message.seq,
          src: source,
          dst: destination,
          ivIndex: getState().ivIndex,
          encAccessPayload: message.upperTransportPdu
        });
        const matched = match(accessPayload);
        if (matched !== undefined && matched !== false) return matched;
        lastMismatch = 'opcode ou format de réponse inattendu';
      } catch (err) {
        lastMismatch = err.message;
      }
    }
    throw new Error(`Délai dépassé en attente de la réponse attendue${lastMismatch ? ` (${lastMismatch})` : ''}`);
  }

  async function exchangeConfigMessage(session, node, accessPayload, expectedOpcode, allocator = seqAllocator()) {
    const state = getState();
    const src = forcedProvisionerAddress ?? state.provisionerAddress;
    const dst = node.unicastAddress;
    const devKey = nodeDeviceKeyBuffer(node);
    session.clearInbox(dst);
    await session.send({ seqAllocator: allocator, src, dst, key: devKey, keyType: 'device', aid: 0, accessPayload });
    return receiveAccessMatching(session, {
      source: dst,
      destination: src,
      key: devKey,
      expectedKeyType: 'device',
      timeoutMs: CONFIG_RESPONSE_TIMEOUT_MS,
      match: (decrypted) => {
        const decoded = decodeAccessOpcode(decrypted);
        return decoded.opcode === expectedOpcode ? decoded : undefined;
      }
    });
  }

  async function closeProxy() {
    if (proxyConn) { try { await proxyConn.close(); } catch { /* déjà fermé */ } }
    proxyConn = null;
    proxySession = null;
  }

  let ensureProxyPromise = null;
  // Dernier candidat Proxy avec lequel une session a réussi (mémoire process
  // uniquement). Permet une reconnexion DIRECTE après une coupure (drop GATT,
  // closeOnTimeout d'une lecture) sans re-payer le pré-scan de 8 s : le worker de
  // session refait de toute façon son propre scan ciblé sur cette identité (RPA-safe,
  // matching par Network ID, cf. ble-session-worker.js#selectProxyTargets). Candidat
  // périmé (lampe éteinte/reset) = échec de connexion → invalidé, repli sur le scan
  // complet ci-dessous. Jamais persisté : au redémarrage du compagnon, premier
  // établissement par scan complet comme avant.
  let lastGoodProxyCandidate = null;

  async function ensureProxySession() {
    if (proxySession?.connected) return proxySession;
    // Mutex : deux commandes simultanées (index.js pilote les lampes en concurrence)
    // ne doivent pas ouvrir deux connexions GATT en parallèle vers la même lampe — la
    // seconde échouerait (un périphérique BLE n'accepte qu'un central à la fois) et la
    // première resterait ouverte sans être référencée.
    if (!ensureProxyPromise) {
      ensureProxyPromise = establishProxySession().finally(() => { ensureProxyPromise = null; });
    }
    return ensureProxyPromise;
  }

  async function connectProxyCandidate(candidate) {
    const state = getState();
    const netKeys = netKeysFor(state);
    const sessionRef = { feed: () => {} };
    const conn = await openProxyConnection(candidate.device, { onData: (bytes) => sessionRef.feed(bytes) });
    try {
      const provisionerAddress = forcedProvisionerAddress ?? state.provisionerAddress;
      const session = createProxySession({
        conn,
        netKeys,
        ivIndex: state.ivIndex,
        provisionerAddress,
        seqAllocatorFactory: seqAllocator
      });
      sessionRef.feed = session.feed;
      await session.configureProxyFilter([provisionerAddress]);
      proxyConn = conn;
      proxySession = session;
      lastGoodProxyCandidate = candidate;
      return session;
    } catch (err) {
      try { await conn.close(); } catch { /* connexion déjà fermée */ }
      throw err;
    }
  }

  async function establishProxySession() {
    const state = getState();
    if (proxySession?.connected) return proxySession;
    await closeProxy();

    if (state.nodes.length === 0) throw new Error('Aucune lampe provisionnée');
    const netKeys = netKeysFor(state);

    // Fast-path : reconnexion directe au dernier Proxy connu, sans pré-scan (cf.
    // commentaire de lastGoodProxyCandidate). L'authenticité réseau reste garantie
    // par le déchiffrement mesh (mauvais réseau = configureProxyFilter échoue).
    if (lastGoodProxyCandidate) {
      const candidate = lastGoodProxyCandidate;
      try {
        return await connectProxyCandidate(candidate);
      } catch (err) {
        lastGoodProxyCandidate = null;
        log.warn('Reconnexion directe au dernier Proxy connu échouée, re-scan complet', err.message);
      }
    }

    // Fenêtre >= 6s : en dessous, le scan manque souvent les annonces exploitables
    // (les premiers paquets publicitaires d'un appareil sont parfois incomplets —
    // vérifié sur matériel réel, cf. patch webbluetooth scanUpdated).
    const candidates = await scanForLampAdvertisements({ timeoutMs: 8000 });
    const expectedNetworkId = toHex(netKeys.networkId);
    // Une annonce Network ID authentifie le réseau avant même l'ouverture GATT.
    // Les annonces Node Identity ne permettent pas ce tri et ne sont donc essayées
    // qu'après tous les candidats dont le Network ID correspond exactement.
    const exactCandidates = candidates.filter((candidate) => candidate.kind === 'provisioned'
      && candidate.networkId && toHex(candidate.networkId) === expectedNetworkId);
    const identityCandidates = candidates.filter((candidate) => candidate.kind === 'provisioned'
      && !candidate.networkId);
    const proxyCandidates = [...exactCandidates, ...identityCandidates];
    if (proxyCandidates.length === 0) throw new Error('Aucune lampe SmallRig joignable en Bluetooth à proximité');

    let lastError;
    for (const candidate of proxyCandidates) {
      try {
        return await connectProxyCandidate(candidate);
      } catch (err) {
        lastError = err;
        log.warn('Connexion Proxy échouée sur un candidat, essai suivant', err.message);
      }
    }
    throw lastError || new Error('Connexion Proxy impossible');
  }

  // --- Découverte -----------------------------------------------------------------

  // Les tests peuvent fournir des Buffer, tandis que les workers de scan renvoient
  // des chaînes hexadécimales : on normalise les deux formes.
  function toHex(value) {
    if (!value) return null;
    return Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  }

  async function discover({ timeoutMs = 6000 } = {}) {
    const state = getState();
    const netKeys = state.netKey ? netKeysFor(state) : null;
    const ourNetworkIdHex = netKeys ? toHex(netKeys.networkId) : null;
    const pairedUuids = new Set(state.nodes.map((n) => n.uuid));
    const found = await scanForDisplayFn({ timeoutMs });

    return found
      .map((f) => {
        if (f.kind === 'unprovisioned') {
          return { bleDeviceId: f.bleDeviceId, kind: 'unprovisioned', deviceUuid: toHex(f.deviceUuid), rssi: f.rssi, name: f.name };
        }
        const isOurs = Boolean(ourNetworkIdHex && f.networkId && toHex(f.networkId) === ourNetworkIdHex);
        return { bleDeviceId: f.bleDeviceId, kind: 'provisioned', ours: isOurs, rssi: f.rssi, name: f.name };
      })
      // Une lampe déjà appairée localement ne doit jamais réapparaître comme
      // « nouvelle » : un firmware qui continue d'émettre un beacon non-provisionné
      // après coup (observé en dehors du provisioning lui-même, cf. RM75_SPEC_DEV.md
      // §12) ne doit pas polluer la liste d'ajout.
      .filter((lamp) => lamp.kind !== 'unprovisioned' || !pairedUuids.has(lamp.deviceUuid?.toLowerCase()));
  }

  // --- Provisioning -----------------------------------------------------------------

  async function provision({ bleDeviceId, deviceUuid, name, attentionDurationS = 0 } = {}) {
    const state = getState();
    if (!persistState) throw new Error('Persistance durable requise avant provisioning mesh');
    ensureNetworkKeys(state);
    await persistState(state);

    await closeProxy(); // libère l'adaptateur pour le scan et la connexion de provisioning

    const reassembler = createProxyPduReassembler();
    const pending = createAsyncQueue();
    const onData = (bytes) => {
      const msg = reassembler.feed(bytes);
      if (msg && msg.type === PROXY_PDU_TYPE.PROVISIONING) pending.push(msg.data);
    };

    // Tous les scans et toute la session GATT sont exécutés dans des processus Node
    // dédiés. Chaque tentative refait un scan puis ouvre un worker neuf : aucun handle
    // WinRT périmé et aucun appel natif ne restent dans le processus Electron.
    const PROVISION_ATTEMPTS = 3;
    let conn = null;
    let target = null;
    let targetUuid = null;
    let staleTargetReconciled = false;
    let seenAsProvisioned = false;
    let lastConnectError = null;
    for (let attempt = 1; attempt <= PROVISION_ATTEMPTS && !conn; attempt++) {
      const found = await scanForLampAdvertisements({ timeoutMs: 8000 });
      target = found.find((f) => f.kind === 'unprovisioned' && (
        f.bleDeviceId === bleDeviceId
        || (deviceUuid && toHex(f.deviceUuid)?.toLowerCase() === deviceUuid.toLowerCase())
      )) || null;
      if (!target) {
        seenAsProvisioned = found.some((f) => f.bleDeviceId === bleDeviceId && f.kind === 'provisioned');
        log.warn(`Scan d'appairage : lampe cible non trouvée (essai ${attempt}/${PROVISION_ATTEMPTS})`, {
          bleDeviceId,
          seenAsProvisioned,
          found: found.map((f) => ({ bleDeviceId: f.bleDeviceId, kind: f.kind, rssi: f.rssi }))
        });
        if (seenAsProvisioned) break; // état stable : inutile de rescanner, le message d'erreur guide vers le reset
        if (attempt < PROVISION_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      targetUuid = toHex(target.deviceUuid)?.toLowerCase() || null;
      if (!targetUuid || !/^[0-9a-f]{32}$/.test(targetUuid)) {
        throw new Error('Annonce de provisioning SmallRig invalide : Device UUID Mesh absent ou mal formé');
      }
      // Un beacon 0x1827 portant le même Device UUID prouve que cette lampe est
      // actuellement non provisionnée. Un nœud/journal local du même UUID vient donc
      // d'une tentative interrompue ou d'un reset usine : le retirer durablement avant
      // de créer une nouvelle DevKey évite un état nodes/pending contradictoire.
      if (!staleTargetReconciled && targetUuid) {
        const staleNode = findNode(state, targetUuid);
        const removedStaleNode = removeNode(state, targetUuid);
        const clearedStalePending = state.pendingProvisioning?.uuid === targetUuid;
        clearPendingProvisioning(state, targetUuid);
        if (removedStaleNode || clearedStalePending) {
          await persistState(state);
          log.info('Etat local obsolète réconcilié avec le beacon non provisionné', {
            uuid: targetUuid,
            removedStaleNode,
            clearedStalePending,
            previousConfigurationStatus: staleNode?.configurationStatus || null
          });
        }
        staleTargetReconciled = true;
      }
      try {
        conn = await openProvisioningConnection(target.device, { onData });
      } catch (err) {
        lastConnectError = err;
        log.warn(`Connexion GATT de provisioning échouée (essai ${attempt}/${PROVISION_ATTEMPTS})`, err.message);
        if (attempt < PROVISION_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!conn) {
      if (seenAsProvisioned) {
        throw new Error('Cette lampe est déjà provisionnée (par ce compagnon, l\'app SmallGoGo ou un autre appareil). Réinitialise son réseau mesh (reset usine) puis relance un scan.');
      }
      if (lastConnectError) {
        throw new Error(`Connexion à la lampe impossible après ${PROVISION_ATTEMPTS} essais : ${lastConnectError.message}. Rapproche la lampe du dongle et réessaie.`);
      }
      throw new Error('Lampe introuvable malgré plusieurs scans (hors de portée, éteinte, ou adaptateur Bluetooth capricieux — réessaie, et relance un scan si besoin)');
    }

    const transport = {
      async send(type, params) {
        const data = Buffer.concat([Buffer.from([type]), params]);
        const fragments = encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: conn.maxAttributeValueLength });
        for (const fragment of fragments) await conn.write(fragment);
      },
      async receive(expectedType) {
        const raw = await pending.shift(CONFIG_RESPONSE_TIMEOUT_MS);
        const type = raw[0];
        if (type !== expectedType) throw new Error(`Provisioning : type inattendu (attendu ${expectedType}, reçu ${type})`);
        return raw.subarray(1);
      }
    };

    let result;
    let provisioningJournaled = false;
    const pendingBeforeProvisioning = state.pendingProvisioning ? { ...state.pendingProvisioning } : null;
    const nextUnicastAddressBeforeProvisioning = state.nextUnicastAddress;
    try {
      result = await runProvisioningFn({
        transport,
        netKey: netKeyBuffer(state),
        keyIndex: 0,
        ivIndex: state.ivIndex,
        unicastAddress: (capabilities) => allocateUnicastAddress(state, Math.max(1, capabilities.numElements)),
        attentionDurationS,
        onBeforeData: async ({ deviceKey, unicastAddress, numElements }) => {
          setPendingProvisioning(state, {
            uuid: targetUuid,
            bleDeviceId,
            name: name || null,
            unicastAddress,
            elementCount: numElements,
            deviceKey: deviceKey.toString('hex'),
            vendorElementAddress: unicastAddress,
            phase: 'data-ready',
            startedAt: new Date().toISOString()
          });
          await persistState(state);
          provisioningJournaled = true;
        }
      });
    } catch (err) {
      if (err.provisioningDataMayHaveBeenSent === false) {
        // Le premier send(DATA) n'a pas commencé : l'allocation et l'éventuel
        // journal de cette tentative peuvent être annulés sans ambiguïté.
        state.nextUnicastAddress = nextUnicastAddressBeforeProvisioning;
        setPendingProvisioning(state, pendingBeforeProvisioning);
        if (provisioningJournaled) {
          await persistState(state);
        }
      } else if (provisioningJournaled && state.pendingProvisioning) {
        addNode(state, {
          ...state.pendingProvisioning,
          configurationStatus: 'provisioning-uncertain',
          configurationError: err.message
        });
        if (persistState) await persistState(state);
      }
      throw err;
    } finally {
      await conn.close();
    }

    const node = addNode(state, {
      uuid: targetUuid,
      name: name || null,
      unicastAddress: result.unicastAddress,
      elementCount: result.numElements,
      deviceKey: result.deviceKey,
      configurationStatus: 'pending'
    });
    clearPendingProvisioning(state, node.uuid);
    if (persistState) await persistState(state);

    // La lampe bascule 0x1827 -> 0x1828 après le Complete (§4) : laisse-lui le temps
    // puis configure (AppKey Add + Model App Bind), condition nécessaire pour que les
    // commandes de contrôle soient acceptées (§8). En pratique sur matériel réel, cette
    // bascule peut prendre plus de temps que prévu de façon irrégulière (observé) :
    // quelques essais supplémentaires évitent d'échouer tout le provisioning pour un
    // simple délai, alors que le nœud est déjà valide côté clés (juste pas encore
    // configuré).
    const CONFIGURE_ATTEMPTS = 3;
    let lastConfigureError;
    for (let attempt = 1; attempt <= CONFIGURE_ATTEMPTS; attempt++) {
      try {
        await configureNode(node);
        lastConfigureError = null;
        break;
      } catch (err) {
        lastConfigureError = err;
        log.warn(`Configuration post-provisioning échouée (essai ${attempt}/${CONFIGURE_ATTEMPTS})`, err.message);
        if (attempt < CONFIGURE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (lastConfigureError) {
      node.configurationStatus = 'pending';
      node.configurationError = lastConfigureError.message;
      if (persistState) await persistState(state);
      let resetError = null;
      try {
        await resetAndRemoveNode(state, node);
      } catch (err) {
        // Le Node Reset radio a déjà réussi : seul le retrait durable local est
        // resté en suspens. Ne jamais retomber dans le résultat `provisioned: true`,
        // qui ferait croire que la lampe accepte encore nos clés. Le journal
        // pendingNodeReset conservé par resetAndRemoveNode permet la reprise.
        if (err.code === 'NODE_RESET_LOCAL_FINALIZE_FAILED') throw err;
        resetError = err;
      }
      if (!resetError) {
        throw new Error(`Configuration post-provisioning échouée ; la lampe a été réinitialisée et le nœud local annulé : ${lastConfigureError.message}`);
      }
      node.configurationStatus = 'pending';
      node.configurationError = `${lastConfigureError.message}; Node Reset impossible: ${resetError.message}`;
      if (persistState) await persistState(state);
      return {
        uuid: node.uuid,
        name: node.name,
        unicastAddress: node.unicastAddress,
        elementCount: node.elementCount,
        provisioned: true,
        configured: false,
        configurationPending: true,
        error: node.configurationError
      };
    }

    return {
      uuid: node.uuid,
      name: node.name,
      unicastAddress: node.unicastAddress,
      elementCount: node.elementCount,
      provisioned: true,
      configured: true,
      configurationPending: false
    };
  }

  async function sendNodeReset(node) {
    return withNodeResponseLock(node.unicastAddress, async () => {
      const session = await ensureProxySession();
      try {
        await exchangeConfigMessage(
          session,
          node,
          Buffer.from([(CONFIG_NODE_RESET_OPCODE >> 8) & 0xff, CONFIG_NODE_RESET_OPCODE & 0xff]),
          CONFIG_NODE_RESET_STATUS_OPCODE
        );
      } catch (err) {
        // Une réponse tardive ne doit jamais satisfaire une future requête sur cette
        // session. Fermer la connexion détruit également son inbox.
        await closeProxy();
        throw err;
      }
      await closeProxy();
      return { reset: true };
    });
  }

  async function resetAndRemoveNode(state, node, { forceLocal = false } = {}) {
    if (!persistState) throw new Error('Persistance durable requise avant suppression d’un nœud mesh');
    if (!forceLocal && state.pendingNodeReset && state.pendingNodeReset.uuid !== node.uuid) {
      const pendingError = new Error(`Un Node Reset est déjà en attente pour ${state.pendingNodeReset.uuid} ; finalisez-le avant d'en lancer un autre`);
      pendingError.code = 'SMALLRIG_NODE_RESET_PENDING';
      throw pendingError;
    }
    // Preflight puis intention durable avant l'effet radio irréversible.
    await persistState(state);
    if (!forceLocal) {
      state.pendingNodeReset = { uuid: node.uuid, requestedAt: new Date().toISOString() };
      await persistState(state);
      try {
        await sendNodeReset(node);
      } catch (err) {
        const wrapped = new Error(`Node Reset impossible : ${err.message}`);
        wrapped.code = 'SMALLRIG_NODE_RESET_FAILED';
        throw wrapped;
      }
    }

    const previousNodes = state.nodes;
    const previousPendingNodeReset = state.pendingNodeReset;
    removeNode(state, node.uuid);
    clearPendingProvisioning(state, node.uuid);
    if (state.pendingNodeReset?.uuid === node.uuid) state.pendingNodeReset = null;
    try {
      await persistState(state);
    } catch (err) {
      // Le journal durable permet la reprise ; restaurer aussi la vue runtime pour ne
      // pas prétendre que la finalisation locale a réussi.
      state.nodes = previousNodes;
      state.pendingNodeReset = previousPendingNodeReset;
      const wrapped = new Error(`Node Reset effectué mais finalisation locale impossible : ${err.message}`);
      wrapped.code = 'NODE_RESET_LOCAL_FINALIZE_FAILED';
      throw wrapped;
    }
    return { removed: true, reset: !forceLocal, forceLocal: Boolean(forceLocal) };
  }

  async function forget({ uuid, forceLocal = false } = {}) {
    const state = getState();
    const node = findNode(state, uuid);
    if (!node) return { removed: false, reset: false, forceLocal: Boolean(forceLocal) };
    const result = await resetAndRemoveNode(state, node, { forceLocal });
    await closeProxy();
    return result;
  }

  // --- Configuration post-provisioning (§8) -----------------------------------------

  async function configureNode(node) {
    return withNodeResponseLock(node.unicastAddress, () => configureNodeUnlocked(node));
  }

  async function configureNodeUnlocked(node) {
    const state = getState();
    if (state.pendingNodeReset?.uuid === node.uuid) {
      throw new Error('Node Reset en attente pour cette lampe ; finalisez l\'oubli local avant de la reconfigurer');
    }
    const netKeys = netKeysFor(state);
    await closeProxy();

    // Reconnexion en mode Proxy (0x1828), après le délai de bascule du firmware —
    // observé sur matériel réel : peut prendre plus que les "1 à 3 secondes" indiqués
    // par la doc (§4). Un court délai de repos avant même de scanner (sans activité
    // BLE) semble aider à la fiabilité de la détection juste après une déconnexion
    // GATT (observé empiriquement), en plus d'une marge généreuse sur le scan lui-même.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const proxyLampCandidates = await waitForProxyAdvertisement({ timeoutMs: 15000 });
    // Préférer une lampe qui annonce NOTRE Network ID (type 0x00) : un candidat
    // étranger ne possède pas notre NetKey et ne relayera jamais nos messages de
    // configuration (symptôme : timeouts silencieux sans erreur). Les annonces Node
    // Identity (type 0x01, sans Network ID lisible) restent acceptées en dernier
    // recours — le NID au déchiffrement fera le tri.
    const expectedNetworkId = toHex(netKeys.networkId);
    const exactCandidates = proxyLampCandidates.filter((candidate) => candidate.networkId
      && toHex(candidate.networkId) === expectedNetworkId);
    const identityCandidates = proxyLampCandidates.filter((candidate) => !candidate.networkId);
    const ourCandidates = [...exactCandidates, ...identityCandidates];
    if (!ourCandidates.length) throw new Error('Aucun Proxy du réseau SmallRig local détecté (Network ID étranger)');
    let conn = null;
    let session = null;
    let lastConnectError = null;
    for (const candidate of ourCandidates) {
      const sessionRef = { feed: () => {} };
      let candidateConn = null;
      try {
        candidateConn = await openProxyConnection(candidate.device, { onData: (bytes) => sessionRef.feed(bytes) });
        const candidateSession = createProxySession({
          conn: candidateConn,
          netKeys,
          ivIndex: state.ivIndex,
          provisionerAddress: forcedProvisionerAddress ?? state.provisionerAddress,
          seqAllocatorFactory: seqAllocator
        });
        sessionRef.feed = candidateSession.feed;
        await candidateSession.configureProxyFilter([forcedProvisionerAddress ?? state.provisionerAddress]);
        conn = candidateConn;
        session = candidateSession;
        break;
      } catch (err) {
        lastConnectError = err;
        if (candidateConn) { try { await candidateConn.close(); } catch { /* déjà fermée */ } }
      }
    }
    if (!session || !conn) throw lastConnectError || new Error('Connexion Proxy impossible pour la configuration');

    try {
      const allocator = seqAllocator();
      const compositionResponse = await exchangeConfigMessage(
        session,
        node,
        encodeCompositionDataGet(0),
        CONFIG_OPCODE.COMPOSITION_DATA_STATUS,
        allocator
      );
      const composition = parseCompositionDataPage0(compositionResponse.params);
      log.info('Composition Data Page 0 reçue', {
        raw: compositionResponse.params.toString('hex'),
        elements: composition.elements.map((element, index) => ({
          index,
          location: `0x${element.location.toString(16).padStart(4, '0')}`,
          sigModels: element.sigModels.map((id) => `0x${id.toString(16).padStart(4, '0')}`),
          vendorModels: element.vendorModels.map((id) => `0x${id.toString(16).padStart(8, '0')}`)
        }))
      });
      if (composition.elements.length !== node.elementCount) {
        throw new Error(`Composition Data incohérente : ${composition.elements.length} éléments, ${node.elementCount} attendus`);
      }
      const vendorElementIndex = composition.elements.findIndex((element) => element.vendorModels.includes(VENDOR_MODEL_ID));
      if (vendorElementIndex < 0 || vendorElementIndex >= node.elementCount) {
        throw new Error('Vendor model DATATRANS_SERVER absent de la Composition Data');
      }
      node.vendorElementAddress = node.unicastAddress + vendorElementIndex;

      const appKey = appKeyBuffer(state);
      const appKeyStatusResponse = await exchangeConfigMessage(
        session,
        node,
        encodeAppKeyAdd({ netKeyIndex: 0, appKeyIndex: 0, appKey }),
        CONFIG_OPCODE.APP_KEY_STATUS,
        allocator
      );
      const appKeyStatus = decodeAppKeyStatus(appKeyStatusResponse.params);
      if (!appKeyStatus.ok) throw new Error(`App Key Add refusé (status ${appKeyStatus.status})`);
      if (appKeyStatus.netKeyIndex !== 0 || appKeyStatus.appKeyIndex !== 0) {
        throw new Error('App Key Status ne correspond pas aux index demandés');
      }

      const modelAppStatusResponse = await exchangeConfigMessage(
        session,
        node,
        encodeModelAppBind({ elementAddress: node.vendorElementAddress, appKeyIndex: 0, modelId: VENDOR_MODEL_ID, isVendorModel: true }),
        CONFIG_OPCODE.MODEL_APP_STATUS,
        allocator
      );
      const modelAppStatus = decodeModelAppStatus(modelAppStatusResponse.params);
      if (!modelAppStatus.ok) throw new Error(`Model App Bind refusé (status ${modelAppStatus.status})`);
      if (modelAppStatus.elementAddress !== node.vendorElementAddress
          || modelAppStatus.appKeyIndex !== 0
          || !modelAppStatus.isVendorModel
          || modelAppStatus.modelId !== VENDOR_MODEL_ID) {
        throw new Error('Model App Status ne correspond pas au bind demandé');
      }

      node.configurationStatus = 'configured';
      node.configurationError = null;
      clearPendingProvisioning(state, node.uuid);
      if (persistState) await persistState(state);
      log.info('Nœud configuré (AppKey + Model App Bind)', { uuid: node.uuid, address: node.vendorElementAddress });
    } catch (err) {
      node.configurationStatus = 'pending';
      node.configurationError = err.message;
      if (persistState) await persistState(state);
      throw err;
    } finally {
      await conn.close();
    }
  }

  // --- Commandes de contrôle (Lq, §9) -----------------------------------------------

  async function sendLqToNode(node, lqFrame) {
    const state = getState();
    const session = await ensureProxySession();
    const appKey = appKeyBuffer(state);
    const aid = deriveAppKeyAid(appKey);
    const accessPayload = buildVendorAccessPayload(lqFrame);
    const dst = node.vendorElementAddress ?? node.unicastAddress;
    await session.send({
      seqAllocator: seqAllocator(),
      src: forcedProvisionerAddress ?? state.provisionerAddress,
      dst,
      key: appKey,
      keyType: 'app',
      aid,
      accessPayload
    });
  }

  // `closeOnTimeout` casse volontairement toute la session Proxy après un échec de
  // lecture (cf. commentaire ci-dessous) : correct, mais un lecteur BEST-EFFORT à
  // haute fréquence (snapshot avant blink, cf. index.js#snapshotLightState, appelé à
  // CHAQUE alerte/test) transformait un simple timeout de lecture en re-scan + re-connexion
  // complète (plusieurs secondes) pour la commande suivante, y compris une commande
  // d'écriture (couleur) qui n'a elle-même jamais besoin de teardown. Un appelant qui
  // n'a pas besoin de cette garantie (résultat déjà toléré `null` en cas d'échec) peut
  // passer `closeOnTimeout: false` et un `timeoutMs` plus court.
  async function readLqFromNode(node, readFrame, decodeResponse, { timeoutMs = COMMAND_RESPONSE_TIMEOUT_MS, closeOnTimeout = true } = {}) {
    const nodeAddress = node.vendorElementAddress ?? node.unicastAddress;
    return withNodeResponseLock(nodeAddress, async () => {
      const state = getState();
      const session = await ensureProxySession();
      const appKey = appKeyBuffer(state);
      const aid = deriveAppKeyAid(appKey);
      const src = forcedProvisionerAddress ?? state.provisionerAddress;
      session.clearInbox(nodeAddress);
      try {
        await session.send({
          seqAllocator: seqAllocator(),
          src,
          dst: nodeAddress,
          key: appKey,
          keyType: 'app',
          aid,
          accessPayload: buildVendorAccessPayload(readFrame)
        });
        return await receiveAccessMatching(session, {
          source: nodeAddress,
          destination: src,
          key: appKey,
          expectedKeyType: 'app',
          expectedAid: aid,
          timeoutMs,
          match: (decrypted) => {
            if (decrypted[0] !== VENDOR_SUBOPCODE_DATA) return undefined;
            return decodeResponse(decrypted.subarray(1));
          }
        });
      } catch (err) {
        // Le protocole Lq n'expose aucun transaction ID. Après timeout, seule une
        // nouvelle session garantit qu'une réponse tardive ne satisfera pas la lecture
        // suivante du même type.
        if (closeOnTimeout) await closeProxy();
        throw err;
      }
    });
  }

  function resolveNodes(uuids) {
    const state = getState();
    const resolved = uuids.map((uuid) => ({ uuid, node: findNode(state, uuid) }));
    const unknown = resolved.filter(({ node }) => !node).map(({ uuid }) => uuid);
    if (unknown.length) throw new Error(`Lampes inconnues ou non provisionnées : ${unknown.join(', ')}`);
    if (resolved.length === 0) throw new Error('Aucune lampe cible connue');
    const resetPending = resolved.filter(({ node }) => state.pendingNodeReset?.uuid === node.uuid).map(({ uuid }) => uuid);
    if (resetPending.length) throw new Error(`Node Reset en attente pour ces lampes : ${resetPending.join(', ')}`);
    const notConfigured = resolved.filter(({ node }) => node.configurationStatus !== 'configured').map(({ uuid }) => uuid);
    if (notConfigured.length) throw new Error(`Lampes non configurées (reconfigure requis) : ${notConfigured.join(', ')}`);
    return resolved.map(({ node }) => node);
  }

  async function forEachNode(uuids, fn) {
    const nodes = resolveNodes(uuids);
    const results = [];
    for (const node of nodes) {
      try {
        results.push({ uuid: node.uuid, ok: true, result: await fn(node) });
      } catch (err) {
        results.push({ uuid: node.uuid, ok: false, error: err.message });
      }
    }
    return results;
  }

  async function setHsi(uuids, { hue, sat, intensity }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeHsi({ hue, sat, intensity })));
  }

  async function setCct(uuids, { kelvin, intensity, gm }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeCct({ kelvin, intensity, gm })));
  }

  async function setRgbw(uuids, { r, g, b, w }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeRgbw({ r, g, b, w })));
  }

  async function setFx(uuids, { mode, param1, param2 }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeFx({ mode, param1, param2 })));
  }

  async function setPower(uuids, { on, level }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, on === false
      ? encodeLumOff()
      : (Number.isFinite(level) ? encodeLumLevel(level) : encodeLumOn())));
  }

  async function readStatus(uuid, options) {
    const [node] = resolveNodes([uuid]);
    return readLqFromNode(node, encodeStatusRead(), decodeStatus, options);
  }

  async function readCapacity(uuid, options) {
    const [node] = resolveNodes([uuid]);
    return readLqFromNode(node, encodeCapacityRead(), (params) => {
      const stripped = stripAtPrefix(params);
      if (stripped.length !== 8 || !/^[0-9]{8}$/.test(stripped.toString('ascii'))) {
        throw new Error('Réponse capacité inattendue');
      }
      return decodeCapacity(params);
    }, options);
  }

  async function readVersion(uuid) {
    const [node] = resolveNodes([uuid]);
    return readLqFromNode(node, encodeVersionRead(), (params) => {
      const stripped = stripAtPrefix(params);
      if (!stripped.toString('latin1').includes('_V')) throw new Error('Réponse version inattendue');
      return decodeVersion(params);
    });
  }

  function listNodes() {
    return getState().nodes.map((node) => ({
      uuid: node.uuid,
      name: node.name,
      unicastAddress: node.unicastAddress,
      vendorElementAddress: node.vendorElementAddress ?? node.unicastAddress,
      configurationStatus: node.configurationStatus || 'unknown',
      configurationPending: node.configurationStatus !== 'configured',
      configurationError: node.configurationError || null,
      resetPending: getState().pendingNodeReset?.uuid === node.uuid
    }));
  }

  async function healthcheck() {
    const state = getState();
    return { paired: state.nodes.length > 0, lamps: state.nodes.length, proxyConnected: Boolean(proxySession?.connected) };
  }

  async function stop() {
    await closeProxy();
  }

  return {
    discover: (payload) => enqueueOperation(() => discover(payload)),
    provision: (payload) => enqueueOperation(() => provision(payload)),
    forget: (payload) => enqueueOperation(() => forget(payload)),
    configureNode: (node) => enqueueOperation(() => configureNode(node)),
    listNodes,
    setHsi: (...args) => enqueueOperation(() => setHsi(...args)),
    setCct: (...args) => enqueueOperation(() => setCct(...args)),
    setRgbw: (...args) => enqueueOperation(() => setRgbw(...args)),
    setFx: (...args) => enqueueOperation(() => setFx(...args)),
    setPower: (...args) => enqueueOperation(() => setPower(...args)),
    readStatus: (...args) => enqueueOperation(() => readStatus(...args)),
    readCapacity: (...args) => enqueueOperation(() => readCapacity(...args)),
    readVersion: (...args) => enqueueOperation(() => readVersion(...args)),
    healthcheck,
    stop: () => enqueueOperation(stop)
  };
}
