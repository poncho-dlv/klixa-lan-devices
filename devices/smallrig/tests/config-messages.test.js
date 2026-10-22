import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_OPCODE,
  decodeAccessOpcode,
  decodeAppKeyStatus,
  decodeModelAppStatus,
  encodeAppKeyAdd,
  encodeCompositionDataGet,
  encodeModelAppBind,
  parseCompositionDataPage0
} from '../src/ble/config-messages.js';

test('encodeCompositionDataGet: opcode 2 octets 0x80 0x08 + page', () => {
  const frame = encodeCompositionDataGet(0);
  assert.deepEqual([...frame], [0x80, 0x08, 0x00]);
});

test('encodeAppKeyAdd: index packé à zéro pour NetKeyIndex=0/AppKeyIndex=0', () => {
  const appKey = Buffer.alloc(16, 0xaa);
  const frame = encodeAppKeyAdd({ netKeyIndex: 0, appKeyIndex: 0, appKey });
  assert.equal(frame[0], CONFIG_OPCODE.APP_KEY_ADD);
  assert.deepEqual([...frame.subarray(1, 4)], [0, 0, 0]);
  assert.deepEqual(frame.subarray(4), appKey);
  assert.equal(frame.length, 1 + 3 + 16);
});

test('encodeModelAppBind: ElementAddress + AppKeyIndex + ModelId vendor (4 octets, CID en premier little-endian)', () => {
  const frame = encodeModelAppBind({ elementAddress: 0x0002, appKeyIndex: 0, modelId: 0x0004005d, isVendorModel: true });
  const decoded = decodeAccessOpcode(frame);
  assert.equal(decoded.opcode, CONFIG_OPCODE.MODEL_APP_BIND);
  assert.deepEqual([...decoded.params.subarray(0, 2)], [0x02, 0x00]); // ElementAddress LE
  assert.deepEqual([...decoded.params.subarray(2, 4)], [0x00, 0x00]); // AppKeyIndex LE
  // ModelId 0x0004005D -> CID 0x005D en premier LE (5D 00), puis ModelID 0x0004 LE (04 00)
  assert.deepEqual([...decoded.params.subarray(4, 8)], [0x5d, 0x00, 0x04, 0x00]);
});

test('decodeAccessOpcode: distingue opcode 1/2/3 octets', () => {
  assert.deepEqual(decodeAccessOpcode(Buffer.from([0x02, 0x01, 0x02])), { opcode: 0x02, length: 1, isVendor: false, params: Buffer.from([0x01, 0x02]) });
  assert.equal(decodeAccessOpcode(Buffer.from([0x80, 0x08])).opcode, 0x8008);
  const vendor = decodeAccessOpcode(Buffer.from([0xe4, 0x5d, 0x00, 0x33]));
  assert.equal(vendor.isVendor, true);
  assert.equal(vendor.vendorCid, 0x005d);
});

test('decodeAppKeyStatus / decodeModelAppStatus: status 0x00 = succès', () => {
  assert.deepEqual(decodeAppKeyStatus(Buffer.from([0x00, 0, 0, 0])), { status: 0, ok: true, netKeyIndex: 0, appKeyIndex: 0 });
  assert.deepEqual(decodeAppKeyStatus(Buffer.from([0x01, 0, 0, 0])), { status: 1, ok: false, netKeyIndex: 0, appKeyIndex: 0 });
  const model = decodeModelAppStatus(Buffer.from([0x00, 0x03, 0x00, 0, 0, 0x5d, 0, 4, 0]));
  assert.equal(model.ok, true);
  assert.equal(model.elementAddress, 3);
  assert.equal(model.modelId, 0x0004005d);
  assert.equal(model.isVendorModel, true);
  assert.throws(() => decodeAppKeyStatus(Buffer.from([0x00])), /mal formé/);
  assert.throws(() => decodeModelAppStatus(Buffer.alloc(8)), /mal formé/);
});

test('parseCompositionDataPage0: détecte le vendor model DATATRANS_SERVER sur le 1er élément', () => {
  // en-tête 11 octets (page+CID+PID+VID+CRPL+Features), puis 1 élément :
  // Location(2) NumS(1)=0 NumV(1)=1, vendor model CID=0x005D ModelID=0x0004 (LE)
  const header = Buffer.from([0x00, 0x5d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const element = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x5d, 0x00, 0x04, 0x00]);
  const parsed = parseCompositionDataPage0(Buffer.concat([header, element]));
  assert.equal(parsed.elements.length, 1);
  assert.deepEqual(parsed.elements[0].vendorModels, [0x0004005d]);
  assert.throws(() => parseCompositionDataPage0(Buffer.concat([header, element.subarray(0, 7)])), /tronquée/);
  const wrongPage = Buffer.from(header);
  wrongPage[0] = 1;
  assert.throws(() => parseCompositionDataPage0(Buffer.concat([wrongPage, element])), /page inattendue/);
});
