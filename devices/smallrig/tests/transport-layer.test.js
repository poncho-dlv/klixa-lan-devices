import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeLowerTransportUnsegmented,
  decodeSegmentHeader,
  decryptUpperTransportAccess,
  deriveAppKeyAid,
  encodeLowerTransportUnsegmented,
  encryptUpperTransportAccess,
  reassembleSegments,
  segmentUpperTransportPdu
} from '../src/ble/transport-layer.js';

const APP_KEY = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff));
const DEV_KEY = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 23 + 11) & 0xff));

test('deriveAppKeyAid: 6 bits (0..63)', () => {
  const aid = deriveAppKeyAid(APP_KEY);
  assert.ok(aid >= 0 && aid <= 0x3f);
});

test('Upper Transport (AppKey): round-trip chiffrement/déchiffrement', () => {
  const accessPayload = Buffer.from('2433040000006464', 'hex');
  const params = { key: APP_KEY, keyType: 'app', seq: 10, src: 2, dst: 0xc001, ivIndex: 0 };
  const enc = encryptUpperTransportAccess({ ...params, accessPayload });
  const dec = decryptUpperTransportAccess({ ...params, encAccessPayload: enc });
  assert.deepEqual(dec, accessPayload);
});

test('Upper Transport (DevKey): round-trip, nonce différent de AppKey', () => {
  const accessPayload = Buffer.from('800800', 'hex'); // Composition Data Get
  const paramsApp = { key: DEV_KEY, keyType: 'app', seq: 5, src: 1, dst: 2, ivIndex: 0 };
  const paramsDevice = { key: DEV_KEY, keyType: 'device', seq: 5, src: 1, dst: 2, ivIndex: 0 };
  const encDevice = encryptUpperTransportAccess({ ...paramsDevice, accessPayload });
  // Le même payload/clé chiffré avec le mauvais type de nonce doit donner un résultat différent
  const encApp = encryptUpperTransportAccess({ ...paramsApp, accessPayload });
  assert.notDeepEqual(encDevice, encApp);
  const dec = decryptUpperTransportAccess({ ...paramsDevice, encAccessPayload: encDevice });
  assert.deepEqual(dec, accessPayload);
});

test('Lower Transport non segmenté : round-trip, rejette >15 octets', () => {
  const upperTransportPdu = Buffer.from('2433040000006464aabbccdd', 'hex').subarray(0, 15);
  const encoded = encodeLowerTransportUnsegmented({ akf: true, aid: 0x12, upperTransportPdu });
  const decoded = decodeLowerTransportUnsegmented(encoded);
  assert.equal(decoded.akf, true);
  assert.equal(decoded.aid, 0x12);
  assert.deepEqual(decoded.upperTransportPdu, upperTransportPdu);

  assert.throws(() => encodeLowerTransportUnsegmented({ akf: false, aid: 0, upperTransportPdu: Buffer.alloc(16) }));
});

test('Segmentation : découpe et réassemble un Upper Transport PDU de 20 octets (2 segments)', () => {
  const upperTransportPdu = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
  const segments = segmentUpperTransportPdu({ akf: true, aid: 7, seqZero: 1234, szmic: false, upperTransportPdu });
  assert.equal(segments.length, 2);

  const headers = segments.map(decodeSegmentHeader);
  assert.equal(headers[0].segO, 0);
  assert.equal(headers[1].segO, 1);
  assert.equal(headers[0].segN, 1);
  assert.equal(headers[0].seqZero, 1234);
  assert.equal(headers[0].aid, 7);
  assert.equal(headers[0].akf, true);

  // réassemblage dans le désordre
  const reassembled = reassembleSegments([headers[1], headers[0]]);
  assert.deepEqual(reassembled.upperTransportPdu, upperTransportPdu);
  assert.equal(reassembled.seqZero, 1234);
});

test('Réassemblage : lève si un segment manque', () => {
  const upperTransportPdu = Buffer.from(Array.from({ length: 30 }, (_, i) => i));
  const segments = segmentUpperTransportPdu({ akf: false, aid: 0, seqZero: 1, szmic: false, upperTransportPdu });
  const headers = segments.map(decodeSegmentHeader);
  assert.throws(() => reassembleSegments([headers[0], headers[2]]), /MISSING_SEGMENT|Segment manquant/);
});
