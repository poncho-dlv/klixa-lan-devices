// État persistant du réseau mesh (CDB simplifié, cf. RM75_SPEC_DEV.md §6/§10) :
// NetKey, AppKey, IVIndex, SEQ (avec réservation par blocs), et la liste des nœuds
// provisionnés (DevKey + adresse unicast + UUID). Fonctions pures sur un objet JS —
// aucune dépendance filesystem/Electron ici (cf. index.js pour le branchement de la
// persistance réelle, mêmes principes que desktop/config-store.js pour Hue).

import { randomBytes } from './mesh-crypto.js';

export const PROVISIONER_ADDRESS = 0x0001;
export const FIRST_NODE_ADDRESS = 0x0002;
export const MAX_UNICAST_ADDRESS = 0x7fff;
export const MAX_SEQ = 0xffffff;
export const SEQ_EXCLUSIVE_LIMIT = MAX_SEQ + 1;
export const DEFAULT_SEQ_BLOCK_SIZE = 100;

export function createEmptyMeshState() {
  return {
    netKey: null,
    appKey: null,
    ivIndex: 0,
    provisionerAddress: PROVISIONER_ADDRESS,
    nextUnicastAddress: FIRST_NODE_ADDRESS,
    seq: 0,
    seqAllocatedUpTo: 0,
    pendingProvisioning: null,
    pendingNodeReset: null,
    nodes: []
  };
}

function meshStateError(message) {
  const error = new Error(`État mesh SmallRig invalide : ${message}`);
  error.code = 'INVALID_MESH_STATE';
  return error;
}

function requireInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw meshStateError(label);
  return value;
}

function requireKey(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value)) throw meshStateError(`${label} doit contenir 16 octets hexadécimaux`);
  return value.toLowerCase();
}

function normalizeStoredNode(node, label = 'nœud') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw meshStateError(`${label} mal formé`);
  if (typeof node.uuid !== 'string' || !/^[0-9a-fA-F]{32}$/.test(node.uuid)) throw meshStateError(`${label}.uuid invalide`);
  const unicastAddress = requireInteger(node.unicastAddress, FIRST_NODE_ADDRESS, MAX_UNICAST_ADDRESS, `${label}.unicastAddress hors plage`);
  const elementCount = requireInteger(node.elementCount, 1, 255, `${label}.elementCount hors plage`);
  if (unicastAddress + elementCount - 1 > MAX_UNICAST_ADDRESS) throw meshStateError(`${label} dépasse la plage unicast`);
  const vendorElementAddress = node.vendorElementAddress == null
    ? unicastAddress
    : requireInteger(node.vendorElementAddress, unicastAddress, unicastAddress + elementCount - 1, `${label}.vendorElementAddress hors du nœud`);
  const configurationStatus = node.configurationStatus || 'unknown';
  if (!['unknown', 'pending', 'configured', 'provisioning-uncertain'].includes(configurationStatus)) {
    throw meshStateError(`${label}.configurationStatus invalide`);
  }
  return {
    ...node,
    uuid: node.uuid.toLowerCase(),
    name: typeof node.name === 'string' && node.name ? node.name : node.uuid.toLowerCase(),
    unicastAddress,
    elementCount,
    deviceKey: requireKey(node.deviceKey, `${label}.deviceKey`),
    vendorElementAddress,
    configurationStatus,
    configurationError: typeof node.configurationError === 'string' ? node.configurationError : null
  };
}

export function parseMeshState(json) {
  if (!json) return createEmptyMeshState();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw meshStateError(`JSON illisible (${error.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw meshStateError('racine JSON non objet');

  const empty = createEmptyMeshState();
  const netKey = parsed.netKey == null ? null : requireKey(parsed.netKey, 'netKey');
  const appKey = parsed.appKey == null ? null : requireKey(parsed.appKey, 'appKey');
  if (Boolean(netKey) !== Boolean(appKey)) throw meshStateError('NetKey et AppKey doivent être présentes ensemble');
  const ivIndex = requireInteger(parsed.ivIndex ?? empty.ivIndex, 0, 0xffffffff, 'ivIndex hors plage');
  const provisionerAddress = requireInteger(parsed.provisionerAddress ?? empty.provisionerAddress, 1, MAX_UNICAST_ADDRESS, 'provisionerAddress hors plage');
  const nextUnicastAddress = requireInteger(parsed.nextUnicastAddress ?? empty.nextUnicastAddress, FIRST_NODE_ADDRESS, MAX_UNICAST_ADDRESS + 1, 'nextUnicastAddress hors plage');
  const parsedSeq = requireInteger(parsed.seq ?? 0, 0, SEQ_EXCLUSIVE_LIMIT, 'seq hors plage');
  const parsedHighWater = requireInteger(parsed.seqAllocatedUpTo ?? parsedSeq, 0, SEQ_EXCLUSIVE_LIMIT, 'seqAllocatedUpTo hors plage');
  if (parsedHighWater < parsedSeq) throw meshStateError('seq dépasse sa borne durable');
  const resumedSeq = Math.max(parsedSeq, parsedHighWater);
  if (parsed.nodes != null && !Array.isArray(parsed.nodes)) throw meshStateError('nodes doit être un tableau');
  const nodes = (parsed.nodes || []).map((node, index) => normalizeStoredNode(node, `nodes[${index}]`));

  let pendingProvisioning = null;
  if (parsed.pendingProvisioning != null) {
    const normalizedPending = normalizeStoredNode({
      ...parsed.pendingProvisioning,
      configurationStatus: 'provisioning-uncertain'
    }, 'pendingProvisioning');
    pendingProvisioning = { ...parsed.pendingProvisioning, ...normalizedPending };
    const existingNode = nodes.find((node) => node.uuid === normalizedPending.uuid);
    if (existingNode && (existingNode.unicastAddress !== normalizedPending.unicastAddress
        || existingNode.elementCount !== normalizedPending.elementCount
        || existingNode.deviceKey !== normalizedPending.deviceKey)) {
      throw meshStateError('pendingProvisioning contredit le nœud conservé du même UUID');
    }
    if (!existingNode) {
      nodes.push({
        ...normalizedPending,
        configurationStatus: 'provisioning-uncertain',
        configurationError: 'Provisioning interrompu avant confirmation Complete'
      });
    }
  }

  let pendingNodeReset = null;
  if (parsed.pendingNodeReset != null) {
    if (!parsed.pendingNodeReset || typeof parsed.pendingNodeReset !== 'object'
        || typeof parsed.pendingNodeReset.uuid !== 'string'
        || !/^[0-9a-fA-F]{32}$/.test(parsed.pendingNodeReset.uuid)) {
      throw meshStateError('pendingNodeReset mal formé');
    }
    pendingNodeReset = { ...parsed.pendingNodeReset, uuid: parsed.pendingNodeReset.uuid.toLowerCase() };
  }

  const uuids = new Set();
  const ranges = [];
  for (const node of nodes) {
    if (uuids.has(node.uuid)) throw meshStateError(`UUID dupliqué (${node.uuid})`);
    uuids.add(node.uuid);
    const start = node.unicastAddress;
    const end = start + node.elementCount - 1;
    if (provisionerAddress >= start && provisionerAddress <= end) throw meshStateError(`adresse du provisioner chevauche ${node.uuid}`);
    for (const range of ranges) {
      if (start <= range.end && end >= range.start) throw meshStateError(`plages unicast chevauchantes (${range.uuid}/${node.uuid})`);
    }
    ranges.push({ start, end, uuid: node.uuid });
  }
  const highestAllocatedAddress = ranges.reduce((highest, range) => Math.max(highest, range.end), FIRST_NODE_ADDRESS - 1);
  if (nextUnicastAddress <= highestAllocatedAddress) throw meshStateError('nextUnicastAddress réutiliserait une plage déjà attribuée');
  if (nodes.length && (!netKey || !appKey)) throw meshStateError('des nœuds existent sans NetKey/AppKey');
  if (pendingNodeReset && !nodes.some((node) => node.uuid === pendingNodeReset.uuid)) {
    throw meshStateError('pendingNodeReset ne correspond à aucun nœud conservé');
  }

  // `seqAllocatedUpTo` est une borne exclusive déjà durable. Après un crash, tous les
  // SEQ du bloc ont potentiellement été vus : on reprend à la borne, jamais au compteur
  // runtime sauvegardé au début du bloc.
  return {
    ...empty,
    ...parsed,
    netKey,
    appKey,
    ivIndex,
    provisionerAddress,
    nextUnicastAddress,
    seq: resumedSeq,
    seqAllocatedUpTo: Math.max(resumedSeq, parsedHighWater),
    pendingProvisioning,
    pendingNodeReset,
    nodes
  };
}

export function serializeMeshState(state) {
  return JSON.stringify(state);
}

// Génère NetKey/AppKey localement au premier provisioning (jamais fournies par le
// cloud — même principe que HUE_APP_KEY : générées et conservées uniquement en local).
export function ensureNetworkKeys(state) {
  if (!state.netKey) state.netKey = randomBytes(16).toString('hex');
  if (!state.appKey) state.appKey = randomBytes(16).toString('hex');
  return state;
}

export function netKeyBuffer(state) {
  return Buffer.from(state.netKey, 'hex');
}

export function appKeyBuffer(state) {
  return Buffer.from(state.appKey, 'hex');
}

// Réserve un bloc d'adresses unicast pour un nœud de `elementCount` éléments.
export function allocateUnicastAddress(state, elementCount) {
  if (!Number.isSafeInteger(elementCount) || elementCount < 1 || elementCount > 255) {
    throw new Error('Nombre d’éléments invalide pour l’allocation unicast');
  }
  let address = state.nextUnicastAddress;
  const provisionerAddress = Number.isSafeInteger(state.provisionerAddress)
    ? state.provisionerAddress
    : PROVISIONER_ADDRESS;
  // Une adresse de provisioner personnalisée peut se trouver au milieu de la plage
  // encore libre. Ne jamais attribuer cette adresse à un élément de lampe.
  if (provisionerAddress >= address && provisionerAddress <= address + elementCount - 1) {
    address = provisionerAddress + 1;
  }
  if (address + elementCount - 1 > MAX_UNICAST_ADDRESS) {
    throw new Error('Plage d\'adresses unicast épuisée');
  }
  state.nextUnicastAddress = address + elementCount;
  return address;
}

// SEQ avec réservation par blocs (RM75_SPEC_DEV.md §7) : quand `seq` atteint la borne
// déjà persistée, on avance la borne AVANT de renvoyer le numéro, pour que
// `crossedBoundary` indique qu'il faut persister l'état avant d'émettre ce message
// (sinon un crash pourrait faire réutiliser un SEQ déjà vu par les nœuds -> message
// silencieusement ignoré, cf. doc §7).
export function nextSeq(state, blockSize = DEFAULT_SEQ_BLOCK_SIZE) {
  if (!Number.isSafeInteger(state.seq) || state.seq < 0) throw new Error('SEQ mesh invalide');
  if (!Number.isSafeInteger(state.seqAllocatedUpTo) || state.seqAllocatedUpTo < 0 || state.seqAllocatedUpTo > SEQ_EXCLUSIVE_LIMIT) {
    throw new Error('Borne de réservation SEQ mesh invalide');
  }
  if (state.seq > MAX_SEQ) {
    const err = new Error('SEQ mesh 24 bits épuisé — IV Update requis avant tout nouvel envoi');
    err.code = 'SEQ_EXHAUSTED';
    throw err;
  }
  const safeBlockSize = Math.max(1, Math.trunc(blockSize) || DEFAULT_SEQ_BLOCK_SIZE);
  let crossedBoundary = false;
  if (state.seq >= state.seqAllocatedUpTo) {
    state.seqAllocatedUpTo = Math.min(SEQ_EXCLUSIVE_LIMIT, state.seq + safeBlockSize);
    crossedBoundary = true;
  }
  const seq = state.seq;
  state.seq += 1;
  return { seq, crossedBoundary };
}

export function addNode(state, {
  uuid,
  name,
  unicastAddress,
  elementCount,
  deviceKey,
  vendorElementAddress,
  configurationStatus = 'pending',
  configurationError = null
}) {
  const node = {
    uuid,
    name: name || uuid,
    unicastAddress,
    elementCount,
    deviceKey: Buffer.isBuffer(deviceKey) ? deviceKey.toString('hex') : deviceKey,
    vendorElementAddress: vendorElementAddress ?? unicastAddress,
    configurationStatus,
    configurationError
  };
  state.nodes = [...state.nodes.filter((n) => n.uuid !== uuid), node];
  return node;
}

export function setPendingProvisioning(state, pending) {
  state.pendingProvisioning = pending ? { ...pending } : null;
  return state.pendingProvisioning;
}

export function clearPendingProvisioning(state, uuid) {
  if (!uuid || state.pendingProvisioning?.uuid === uuid) state.pendingProvisioning = null;
}

export function removeNode(state, uuid) {
  const before = state.nodes.length;
  state.nodes = state.nodes.filter((n) => n.uuid !== uuid);
  return state.nodes.length < before;
}

export function findNode(state, uuid) {
  return state.nodes.find((n) => n.uuid === uuid) || null;
}

export function nodeDeviceKeyBuffer(node) {
  return Buffer.from(node.deviceKey, 'hex');
}
