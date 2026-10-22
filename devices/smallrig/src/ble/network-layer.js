// Couche réseau Bluetooth Mesh : chiffrement AES-CCM + obfuscation d'en-tête
// (RM75_SPEC_DEV.md §5). Pure : ne dépend d'aucun transport, testée par round-trip
// chiffrement/déchiffrement (tests/smallrig-network-layer.test.js).

import { aesCcmDecrypt, aesCcmEncrypt, aesEcbEncrypt, k2, k3 } from './mesh-crypto.js';

// Dérive NID/EncryptionKey/PrivacyKey/NetworkID depuis une NetKey — à mettre en cache
// par le store (mesh-store.js), la dérivation est coûteuse et déterministe.
export function deriveNetworkKeys(netKey) {
  const { nid, encryptionKey, privacyKey } = k2(netKey, Buffer.from([0x00]));
  const networkId = k3(netKey);
  return { nid, encryptionKey, privacyKey, networkId };
}

function u24(value) {
  return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u16(value) {
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function networkNonce({ ctl, ttl, seq, src, ivIndex, nonceType = 'network' }) {
  const isProxyConfiguration = nonceType === 'proxy';
  return Buffer.concat([
    Buffer.from([isProxyConfiguration ? 0x03 : 0x00]),
    // Le Proxy Nonce a un octet PAD fixe à zéro. Le Network Nonce transporte CTL/TTL.
    Buffer.from([isProxyConfiguration ? 0x00 : (((ctl ? 1 : 0) << 7) | (ttl & 0x7f))]),
    u24(seq),
    u16(src),
    Buffer.from([0x00, 0x00]),
    u32(ivIndex)
  ]);
}

function privacyRandom(encDstAndTransport) {
  return encDstAndTransport.subarray(0, 7);
}

function pecb({ privacyKey, ivIndex, random7 }) {
  const block = Buffer.concat([Buffer.alloc(5, 0x00), u32(ivIndex), random7]);
  return aesEcbEncrypt(privacyKey, block);
}

// Encode un Network PDU complet à partir d'un Transport PDU déjà produit par la
// couche transport (lower/upper). `ctl`=false pour les messages d'accès (MIC 4
// octets), `ctl`=true pour les messages de contrôle (MIC 8 octets).
export function encryptNetworkPdu({ encryptionKey, privacyKey, nid, ivi, ivIndex, ctl, ttl, seq, src, dst, transportPdu, nonceType = 'network' }) {
  const micLength = ctl ? 8 : 4;
  const nonce = networkNonce({ ctl, ttl, seq, src, ivIndex, nonceType });
  const plaintext = Buffer.concat([u16(dst), transportPdu]);
  const { ciphertext, mic } = aesCcmEncrypt(encryptionKey, nonce, plaintext, micLength);
  const encDstAndTransport = Buffer.concat([ciphertext, mic]);

  const p = pecb({ privacyKey, ivIndex, random7: privacyRandom(encDstAndTransport) });
  const headerPlain = Buffer.concat([Buffer.from([((ctl ? 1 : 0) << 7) | (ttl & 0x7f)]), u24(seq), u16(src)]);
  const obfuscatedHeader = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) obfuscatedHeader[i] = headerPlain[i] ^ p[i];

  const ividNid = Buffer.from([((ivi & 1) << 7) | (nid & 0x7f)]);
  return Buffer.concat([ividNid, obfuscatedHeader, encDstAndTransport]);
}

// Décode un Network PDU reçu. Lève si le NID ne correspond pas à cette NetKey, ou si
// l'authentification AES-CCM échoue (MIC invalide -> rejeu/corruption/mauvaise clé).
export function decryptNetworkPdu({ encryptionKey, privacyKey, nid, ivIndex, pdu, nonceType = 'network' }) {
  if (pdu.length < 7) throw new Error('Network PDU trop court');
  const ividNidByte = pdu[0];
  const pduNid = ividNidByte & 0x7f;
  if (pduNid !== nid) {
    const err = new Error('NID inconnu (pas notre réseau)');
    err.code = 'UNKNOWN_NID';
    throw err;
  }
  const ivi = (ividNidByte >> 7) & 1;
  // Cette implémentation ne gère pas encore l'IV Update et ne conserve donc pas
  // l'IV Index précédent. Accepter un IVI différent tout en essayant l'IV Index
  // courant contournerait le choix d'IV Index imposé par l'en-tête réseau.
  if (ivi !== (ivIndex & 1)) {
    const err = new Error('IVI incompatible avec l\'IV Index courant');
    err.code = 'IVI_MISMATCH';
    throw err;
  }
  const obfuscatedHeader = pdu.subarray(1, 7);
  const encDstAndTransport = pdu.subarray(7);

  const p = pecb({ privacyKey, ivIndex, random7: privacyRandom(encDstAndTransport) });
  const headerPlain = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) headerPlain[i] = obfuscatedHeader[i] ^ p[i];

  const ctl = (headerPlain[0] >> 7) & 1;
  const ttl = headerPlain[0] & 0x7f;
  const seq = (headerPlain[1] << 16) | (headerPlain[2] << 8) | headerPlain[3];
  const src = (headerPlain[4] << 8) | headerPlain[5];

  const micLength = ctl ? 8 : 4;
  if (encDstAndTransport.length < 2 + micLength) throw new Error('Network PDU tronqué');
  const ciphertext = encDstAndTransport.subarray(0, encDstAndTransport.length - micLength);
  const mic = encDstAndTransport.subarray(encDstAndTransport.length - micLength);

  const nonce = networkNonce({ ctl, ttl, seq, src, ivIndex, nonceType });
  const plaintext = aesCcmDecrypt(encryptionKey, nonce, ciphertext, mic, micLength);
  const dst = (plaintext[0] << 8) | plaintext[1];
  const transportPdu = plaintext.subarray(2);

  return { ivi, ctl: Boolean(ctl), ttl, seq, src, dst, transportPdu };
}
