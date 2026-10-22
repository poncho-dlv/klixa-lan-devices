import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_PDU_TYPE,
  createProxyPduReassembler,
  decodeProxyPduFragment,
  encodeProxyPdus
} from '../src/ble/proxy-pdu.js';

test('encodeProxyPdus: message court -> un seul fragment SAR=complete', () => {
  const data = Buffer.from([1, 2, 3]);
  const fragments = encodeProxyPdus(PROXY_PDU_TYPE.NETWORK, data, { maxAttributeValueLength: 20 });
  assert.equal(fragments.length, 1);
  const decoded = decodeProxyPduFragment(fragments[0]);
  assert.equal(decoded.sar, 0b00);
  assert.equal(decoded.type, PROXY_PDU_TYPE.NETWORK);
  assert.deepEqual(decoded.chunk, data);
});

test('encodeProxyPdus: message long -> segmentation first/continuation/last', () => {
  const data = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
  const fragments = encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: 20 });
  assert.ok(fragments.length > 2);
  const decoded = fragments.map(decodeProxyPduFragment);
  assert.equal(decoded[0].sar, 0b01); // FIRST
  for (let i = 1; i < decoded.length - 1; i++) assert.equal(decoded[i].sar, 0b10); // CONTINUATION
  assert.equal(decoded.at(-1).sar, 0b11); // LAST
  for (const d of decoded) assert.equal(d.type, PROXY_PDU_TYPE.PROVISIONING);

  const reassembled = Buffer.concat(decoded.map((d) => d.chunk));
  assert.deepEqual(reassembled, data);
});

test('createProxyPduReassembler: message complet en un fragment', () => {
  const reassembler = createProxyPduReassembler();
  const [frag] = encodeProxyPdus(PROXY_PDU_TYPE.NETWORK, Buffer.from('hello'), { maxAttributeValueLength: 20 });
  const result = reassembler.feed(frag);
  assert.equal(result.type, PROXY_PDU_TYPE.NETWORK);
  assert.deepEqual(result.data, Buffer.from('hello'));
});

test('createProxyPduReassembler: réassemble un message segmenté sur plusieurs feed()', () => {
  const reassembler = createProxyPduReassembler();
  const data = Buffer.from(Array.from({ length: 45 }, (_, i) => 255 - i));
  const fragments = encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: 20 });

  let result = null;
  for (const frag of fragments) {
    const r = reassembler.feed(frag);
    if (r) result = r;
  }
  assert.ok(result);
  assert.equal(result.type, PROXY_PDU_TYPE.PROVISIONING);
  assert.deepEqual(result.data, data);
});

test('createProxyPduReassembler: rejette une continuation sans FIRST préalable', () => {
  const reassembler = createProxyPduReassembler();
  const fake = Buffer.concat([Buffer.from([(0b10 << 6) | PROXY_PDU_TYPE.NETWORK]), Buffer.from([1, 2, 3])]);
  assert.throws(() => reassembler.feed(fake));
});
