import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVendorAccessPayload,
  decodeCapacity,
  decodeStatus,
  decodeVersion,
  encodeCct,
  encodeFx,
  encodeHsi,
  encodeLumOff,
  encodeLumOn,
  encodeRgbw,
  stripAtPrefix
} from '../src/ble/lq-protocol.js';

test('encodeHsi: rouge saturé plein pot (exemple RM75_protocole.md §3)', () => {
  const frame = encodeHsi({ hue: 0, sat: 100, intensity: 100 });
  assert.equal(frame.toString('hex'), Buffer.from([0x33, 0x04, 0x00, 0x00, 0x00, 0x64, 0x64]).toString('hex'));
});

test('encodeCct: 5600K intensité 80% GM neutre — XOR recalculé', () => {
  // Le document source donne xor=0x87 pour cet exemple, mais 0x15^0xE0^0x50^0x32 = 0x97
  // (vérifié). On implémente l'algorithme prosaïque (XOR de tous les octets du payload,
  // sans ambiguïté), pas la valeur numérique de l'exemple qui contient une coquille.
  const frame = encodeCct({ kelvin: 5600, intensity: 80, gm: 0 });
  assert.equal(frame.toString('hex'), Buffer.from([0x34, 0x04, 0x97, 0x15, 0xe0, 0x50, 0x32]).toString('hex'));
});

test('encodeLumOff / encodeLumOn: valeurs sentinelles', () => {
  assert.equal(encodeLumOff().toString('hex'), Buffer.from([0x42, 0x02, 0xfc, 0xfc, 0x00]).toString('hex'));
  assert.equal(encodeLumOn().toString('hex'), Buffer.from([0x42, 0x02, 0xfe, 0xfe, 0x00]).toString('hex'));
});

test('encodeRgbw: encode r,g,b,w bornés 0-255', () => {
  const frame = encodeRgbw({ r: 300, g: -5, b: 128, w: 10 });
  assert.deepEqual([...frame], [0x36, 0x04, (255 ^ 0 ^ 128 ^ 10), 255, 0, 128, 10]);
});

test('encodeFx: formats exacts SmallGoGo pour mode 1, modes courts et autres', () => {
  assert.deepEqual([...encodeFx({ mode: 1, param1: 3, param2: 0x1234 }).subarray(3)], [1, 5, 3, 0x12, 0x34]);
  assert.deepEqual([...encodeFx({ mode: 8, param1: 7, param2: 9 }).subarray(3)], [8, 5, 7]);
  assert.deepEqual([...encodeFx({ mode: 4, param1: 3, param2: 9 }).subarray(3)], [4, 5, 3, 9]);
});

test('decodeStatus: HSI (mode 3), vérifie le XOR', () => {
  const values = [0x00, 0x00, 0x64, 0x64];
  const xor = values.reduce((a, b) => a ^ b, 0);
  const bytes = Buffer.from([3, values.length, xor, ...values]);
  assert.deepEqual(decodeStatus(bytes), { type: 'hsi', hue: 0, sat: 0x64, intensity: 0x64 });
});

test('decodeStatus: rejette un XOR invalide', () => {
  const bytes = Buffer.from([3, 4, 0xff, 0x00, 0x00, 0x64, 0x64]);
  assert.throws(() => decodeStatus(bytes), /XOR invalide/);
});

test('decodeStatus: CCT (mode 4), gm décodé -10', () => {
  const values = [0x15, 0xe0, 80, 50]; // gm encodé = 50 -> décodé 40 ? non: gm brut - 10
  const xor = values.reduce((a, b) => a ^ b, 0);
  const bytes = Buffer.from([4, values.length, xor, ...values]);
  const decoded = decodeStatus(bytes);
  assert.equal(decoded.kelvin, 0x15e0);
  assert.equal(decoded.intensity, 80);
  assert.equal(decoded.gm, 50 - 10);
});

test('decodeCapacity: 8 octets ASCII', () => {
  // batterie 87%, autonomie 12.3h, en charge, allumée
  const bytes = Buffer.from('087123' + '1' + '1', 'ascii');
  const decoded = decodeCapacity(bytes);
  assert.equal(decoded.battery, 87);
  assert.equal(decoded.autonomyHours, 12.3);
  assert.equal(decoded.chargeState, 'charging');
  assert.equal(decoded.poweredOn, true);
});

test('decodeVersion: découpe sur "_V"', () => {
  const decoded = decodeVersion(Buffer.from('RM75_V1.2.3', 'ascii'));
  assert.equal(decoded.type, 'RM75');
  assert.equal(decoded.firmwareVersion, '1.2.3');
});

test('stripAtPrefix: tronque les marqueurs AT+DATA(X)@0001=', () => {
  const inner = Buffer.from([1, 2, 3]);
  assert.deepEqual(stripAtPrefix(Buffer.concat([Buffer.from('AT+DATA@0001=', 'ascii'), inner])), inner);
  assert.deepEqual(stripAtPrefix(Buffer.concat([Buffer.from('AT+DATAX@0001=', 'ascii'), inner])), inner);
  assert.deepEqual(stripAtPrefix(inner), inner);
});

test('buildVendorAccessPayload: opcode brut 0x24 confirmé par SmallGoGo', () => {
  const lqFrame = encodeHsi({ hue: 0, sat: 100, intensity: 100 });
  const payload = buildVendorAccessPayload(lqFrame);
  assert.equal(payload[0], 0x24);
  assert.deepEqual(payload.subarray(1), lqFrame);
});
