// Couches Lower/Upper Transport (RM75_SPEC_DEV.md §6) : chiffrement AppKey/DevKey de
// l'Access Payload, encapsulation SEG/AKF/AID, segmentation et réassemblage (SAR).
// Pure : ne dépend d'aucun transport physique.

import { aesCcmDecrypt, aesCcmEncrypt, k4 } from './mesh-crypto.js';

export const SEGMENT_PAYLOAD_LENGTH = 12;
export const UNSEGMENTED_MAX_ACCESS_LENGTH = 11; // 15 octets d'upper transport - 4 de TransMIC

function u24(value) {
  return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u16(value) {
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

// AID dérivé de l'AppKey (k4), à mettre en cache par le store.
export function deriveAppKeyAid(appKey) {
  return k4(appKey);
}

function upperTransportNonce({ keyType, aszmic, seq, src, dst, ivIndex }) {
  // Le bit ASZMIC s'applique aux DEUX types de nonce (Application ET Device) d'après
  // la spec Mesh Profile 1.0.1 (§3.8.5.3/3.8.5.4) — RM75_SPEC_DEV.md §6 montre le
  // Device nonce avec un octet fixe 0x00 car il n'illustre que le cas non segmenté.
  // Sans ce bit, une réponse de configuration segmentée avec SZMIC=1 (ex. Composition
  // Data Status selon le firmware) serait indéchiffrable.
  return Buffer.concat([
    Buffer.from([keyType === 'device' ? 0x02 : 0x01]),
    Buffer.from([(aszmic ? 1 : 0) << 7]),
    u24(seq),
    u16(src),
    u16(dst),
    u32(ivIndex)
  ]);
}

// keyType: 'app' (AppKey, AKF=1) ou 'device' (DevKey, AKF=0, messages de configuration).
export function encryptUpperTransportAccess({ key, keyType, aszmic = false, seq, src, dst, ivIndex, accessPayload }) {
  const micLength = aszmic ? 8 : 4;
  const nonce = upperTransportNonce({ keyType, aszmic, seq, src, dst, ivIndex });
  const { ciphertext, mic } = aesCcmEncrypt(key, nonce, accessPayload, micLength);
  return Buffer.concat([ciphertext, mic]);
}

export function decryptUpperTransportAccess({ key, keyType, aszmic = false, seq, src, dst, ivIndex, encAccessPayload }) {
  const micLength = aszmic ? 8 : 4;
  if (encAccessPayload.length < micLength) throw new Error('Upper Transport PDU trop court');
  const ciphertext = encAccessPayload.subarray(0, encAccessPayload.length - micLength);
  const mic = encAccessPayload.subarray(encAccessPayload.length - micLength);
  const nonce = upperTransportNonce({ keyType, aszmic, seq, src, dst, ivIndex });
  return aesCcmDecrypt(key, nonce, ciphertext, mic, micLength);
}

// Lower Transport, Access non segmenté : [SEG=0|AKF|AID][upperTransportPdu].
export function encodeLowerTransportUnsegmented({ akf, aid, upperTransportPdu }) {
  if (upperTransportPdu.length > 15) throw new Error('Upper Transport PDU trop long pour du non segmenté (>15 octets)');
  const header = ((akf ? 1 : 0) << 6) | (aid & 0x3f);
  return Buffer.concat([Buffer.from([header]), upperTransportPdu]);
}

export function decodeLowerTransportUnsegmented(bytes) {
  const header = bytes[0];
  const seg = (header >> 7) & 1;
  if (seg !== 0) throw new Error('Trame segmentée passée à decodeLowerTransportUnsegmented');
  return { akf: Boolean((header >> 6) & 1), aid: header & 0x3f, upperTransportPdu: bytes.subarray(1) };
}

// Lower Transport, Access segmenté : découpe un Upper Transport PDU (accessPayload
// chiffré + TransMIC) en segments de 12 octets utiles (RM75_SPEC_DEV.md §6).
export function segmentUpperTransportPdu({ akf, aid, seqZero, szmic, upperTransportPdu }) {
  const segments = [];
  const segN = Math.max(0, Math.ceil(upperTransportPdu.length / SEGMENT_PAYLOAD_LENGTH) - 1);
  for (let segO = 0; segO <= segN; segO++) {
    const chunk = upperTransportPdu.subarray(segO * SEGMENT_PAYLOAD_LENGTH, (segO + 1) * SEGMENT_PAYLOAD_LENGTH);
    const byte0 = 0x80 | ((akf ? 1 : 0) << 6) | (aid & 0x3f);
    const sz = seqZero & 0x1fff;
    const byte1 = ((szmic ? 1 : 0) << 7) | (sz >> 6);
    const byte2 = ((sz & 0x3f) << 2) | (segO >> 3);
    const byte3 = ((segO & 0x07) << 5) | (segN & 0x1f);
    segments.push(Buffer.concat([Buffer.from([byte0, byte1, byte2, byte3]), chunk]));
  }
  return segments;
}

export function decodeSegmentHeader(bytes) {
  const seg = (bytes[0] >> 7) & 1;
  if (seg !== 1) throw new Error('Trame non segmentée passée à decodeSegmentHeader');
  const akf = Boolean((bytes[0] >> 6) & 1);
  const aid = bytes[0] & 0x3f;
  const szmic = Boolean((bytes[1] >> 7) & 1);
  const seqZero = ((bytes[1] & 0x7f) << 6) | (bytes[2] >> 2);
  const segO = ((bytes[2] & 0x03) << 3) | (bytes[3] >> 5);
  const segN = bytes[3] & 0x1f;
  return { akf, aid, szmic, seqZero, segO, segN, chunk: bytes.subarray(4) };
}

// Réassemble un ensemble de segments reçus (dans n'importe quel ordre) en un unique
// Upper Transport PDU. Lève si un segment manque ou si le SegN annoncé diverge.
export function reassembleSegments(segmentHeaders) {
  if (segmentHeaders.length === 0) throw new Error('Aucun segment à réassembler');
  const { segN, akf, aid, szmic, seqZero } = segmentHeaders[0];
  const bySegO = new Map();
  for (const s of segmentHeaders) {
    if (s.segN !== segN || s.seqZero !== seqZero) throw new Error('Segments incohérents (SegN/SeqZero différents)');
    bySegO.set(s.segO, s.chunk);
  }
  for (let i = 0; i <= segN; i++) {
    if (!bySegO.has(i)) {
      const err = new Error(`Segment manquant : ${i}/${segN}`);
      err.code = 'MISSING_SEGMENT';
      throw err;
    }
  }
  const upperTransportPdu = Buffer.concat(Array.from({ length: segN + 1 }, (_, i) => bySegO.get(i)));
  return { akf, aid, szmic, seqZero, upperTransportPdu };
}
