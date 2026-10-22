import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNode,
  allocateUnicastAddress,
  MAX_SEQ,
  createEmptyMeshState,
  ensureNetworkKeys,
  findNode,
  nextSeq,
  parseMeshState,
  removeNode,
  serializeMeshState
} from '../src/ble/mesh-store.js';

test('createEmptyMeshState: valeurs par défaut cohérentes', () => {
  const state = createEmptyMeshState();
  assert.equal(state.netKey, null);
  assert.equal(state.nextUnicastAddress, 0x0002);
  assert.equal(state.provisionerAddress, 0x0001);
  assert.deepEqual(state.nodes, []);
});

test('ensureNetworkKeys: génère NetKey/AppKey une seule fois', () => {
  const state = createEmptyMeshState();
  ensureNetworkKeys(state);
  const netKey = state.netKey;
  const appKey = state.appKey;
  assert.equal(Buffer.from(netKey, 'hex').length, 16);
  assert.equal(Buffer.from(appKey, 'hex').length, 16);
  ensureNetworkKeys(state);
  assert.equal(state.netKey, netKey);
  assert.equal(state.appKey, appKey);
});

test('serializeMeshState/parseMeshState: round-trip', () => {
  const state = createEmptyMeshState();
  ensureNetworkKeys(state);
  const unicastAddress = allocateUnicastAddress(state, 1);
  addNode(state, { uuid: 'aa'.repeat(16), name: 'Lampe salon', unicastAddress, elementCount: 1, deviceKey: Buffer.alloc(16, 1) });
  const json = serializeMeshState(state);
  const restored = parseMeshState(json);
  assert.deepEqual(restored, state);
});

test('parseMeshState: état absent -> état vide, corruption -> échec fail-closed', () => {
  assert.deepEqual(parseMeshState(''), createEmptyMeshState());
  assert.deepEqual(parseMeshState(null), createEmptyMeshState());
  assert.throws(() => parseMeshState('not json'), { code: 'INVALID_MESH_STATE' });
  assert.throws(() => parseMeshState('[]'), { code: 'INVALID_MESH_STATE' });
});

test('allocateUnicastAddress: incrémente selon elementCount, refuse le débordement', () => {
  const state = createEmptyMeshState();
  const a = allocateUnicastAddress(state, 1);
  const b = allocateUnicastAddress(state, 2);
  assert.equal(a, 0x0002);
  assert.equal(b, 0x0003);
  assert.equal(state.nextUnicastAddress, 0x0005);

  state.nextUnicastAddress = 0x7fff;
  assert.throws(() => allocateUnicastAddress(state, 2));
});

test('allocateUnicastAddress: ne chevauche jamais une adresse de provisioner personnalisée', () => {
  const state = createEmptyMeshState();
  state.provisionerAddress = 3;
  assert.equal(allocateUnicastAddress(state, 1), 2);
  assert.equal(allocateUnicastAddress(state, 1), 4);
  assert.equal(state.nextUnicastAddress, 5);

  state.nextUnicastAddress = 6;
  state.provisionerAddress = 7;
  assert.equal(allocateUnicastAddress(state, 2), 8);
});

test('nextSeq: réservation par blocs, crossedBoundary uniquement à la frontière', () => {
  const state = createEmptyMeshState();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(nextSeq(state, 2));
  // bloc de 2 : seq 0 (crossed), seq 1 (pas crossed), seq 2 (crossed), seq 3, seq 4 (crossed)
  assert.deepEqual(results.map((r) => r.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(results.map((r) => r.crossedBoundary), [true, false, true, false, true]);
  assert.equal(state.seqAllocatedUpTo, 6);
});

test('parseMeshState: reprend au high-water mark après reload', () => {
  const state = createEmptyMeshState();
  nextSeq(state, 100); // seq runtime=1, borne durable=100
  const restored = parseMeshState(serializeMeshState(state));
  assert.equal(restored.seq, 100);
  assert.equal(nextSeq(restored, 100).seq, 100);
});

test('nextSeq: accepte 0xFFFFFF une fois puis exige IV Update', () => {
  const state = createEmptyMeshState();
  state.seq = MAX_SEQ;
  state.seqAllocatedUpTo = MAX_SEQ;
  assert.equal(nextSeq(state, 100).seq, MAX_SEQ);
  assert.throws(() => nextSeq(state, 100), { code: 'SEQ_EXHAUSTED' });
});

test('parseMeshState: valide clés, UUID, plages et chevauchements', () => {
  const base = createEmptyMeshState();
  base.netKey = '11'.repeat(16);
  base.appKey = '22'.repeat(16);

  assert.throws(() => parseMeshState(JSON.stringify({ ...base, netKey: 'abcd' })), /netKey/);
  assert.throws(() => parseMeshState(JSON.stringify({ ...base, seq: MAX_SEQ + 2 })), /seq hors plage/);
  assert.throws(() => parseMeshState(JSON.stringify({ ...base, seq: 10, seqAllocatedUpTo: 5 })), /borne durable/);

  const nodeA = {
    uuid: 'aa'.repeat(16), name: 'A', unicastAddress: 2, elementCount: 2,
    vendorElementAddress: 2, deviceKey: '33'.repeat(16), configurationStatus: 'configured'
  };
  assert.throws(() => parseMeshState(JSON.stringify({ ...base, nextUnicastAddress: 4, nodes: [{ ...nodeA, uuid: 'bad' }] })), /uuid/);
  assert.throws(() => parseMeshState(JSON.stringify({
    ...base,
    nextUnicastAddress: 5,
    nodes: [nodeA, { ...nodeA, uuid: 'bb'.repeat(16), unicastAddress: 3, vendorElementAddress: 3 }]
  })), /chevauchantes/);
  assert.throws(() => parseMeshState(JSON.stringify({ ...base, nextUnicastAddress: 3, nodes: [nodeA] })), /réutiliserait/);
});

test('parseMeshState: récupère un provisioning journalisé avant Complete', () => {
  const state = createEmptyMeshState();
  state.netKey = '11'.repeat(16);
  state.appKey = '22'.repeat(16);
  state.nextUnicastAddress = 3;
  state.pendingProvisioning = {
    uuid: 'cc'.repeat(16),
    name: 'Incertaine',
    unicastAddress: 2,
    elementCount: 1,
    vendorElementAddress: 2,
    deviceKey: '33'.repeat(16),
    phase: 'data-ready'
  };
  const restored = parseMeshState(serializeMeshState(state));
  assert.equal(restored.nodes.length, 1);
  assert.equal(restored.nodes[0].configurationStatus, 'provisioning-uncertain');
  assert.equal(restored.pendingProvisioning.uuid, 'cc'.repeat(16));

  state.nodes.push({
    ...state.pendingProvisioning,
    deviceKey: '44'.repeat(16),
    configurationStatus: 'provisioning-uncertain'
  });
  assert.throws(() => parseMeshState(serializeMeshState(state)), /contredit/);
});

test('parseMeshState: conserve un Node Reset journalisé et refuse une cible absente', () => {
  const state = createEmptyMeshState();
  state.netKey = '11'.repeat(16);
  state.appKey = '22'.repeat(16);
  state.nextUnicastAddress = 3;
  state.nodes.push({
    uuid: 'dd'.repeat(16),
    name: 'Reset incertain',
    unicastAddress: 2,
    vendorElementAddress: 2,
    elementCount: 1,
    deviceKey: '33'.repeat(16),
    configurationStatus: 'configured'
  });
  state.pendingNodeReset = { uuid: 'dd'.repeat(16), requestedAt: '2026-07-20T10:00:00.000Z' };
  const restored = parseMeshState(serializeMeshState(state));
  assert.deepEqual(restored.pendingNodeReset, state.pendingNodeReset);

  state.pendingNodeReset.uuid = 'ee'.repeat(16);
  assert.throws(() => parseMeshState(serializeMeshState(state)), /aucun nœud/);
});

test('addNode/removeNode/findNode', () => {
  const state = createEmptyMeshState();
  addNode(state, { uuid: 'aa', unicastAddress: 2, elementCount: 1, deviceKey: Buffer.alloc(16) });
  addNode(state, { uuid: 'bb', unicastAddress: 3, elementCount: 1, deviceKey: Buffer.alloc(16) });
  assert.equal(state.nodes.length, 2);
  assert.ok(findNode(state, 'aa'));

  // Re-provisionner le même uuid remplace l'entrée plutôt que de la dupliquer
  addNode(state, { uuid: 'aa', unicastAddress: 9, elementCount: 1, deviceKey: Buffer.alloc(16) });
  assert.equal(state.nodes.length, 2);
  assert.equal(findNode(state, 'aa').unicastAddress, 9);

  assert.equal(removeNode(state, 'aa'), true);
  assert.equal(state.nodes.length, 1);
  assert.equal(removeNode(state, 'zz'), false);
});
