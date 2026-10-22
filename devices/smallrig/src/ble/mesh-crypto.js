import crypto from 'node:crypto';

// Primitives cryptographiques Bluetooth Mesh Profile 1.0.1 (Annexe 8) : AES-CMAC
// (RFC 4493), les dérivations s1/k1/k2/k3/k4, AES-CCM, et l'échange ECDH P-256 du
// provisioning. Aucune de ces fonctions ne dépend du matériel Bluetooth : elles sont
// testées unitairement (tests/smallrig-mesh-crypto.test.js), cf. RM75_SPEC_DEV.md §3.

const ZERO16 = Buffer.alloc(16);
const RB = 0x87n; // constante de génération de sous-clé CMAC (RFC 4493 §2.3)

function aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

// Un seul bloc AES-128-ECB (16 octets) — utilisé pour l'obfuscation d'en-tête réseau
// (PECB, cf. RM75_SPEC_DEV.md §5), en plus de CMAC en interne.
export const aesEcbEncrypt = aesEcbEncryptBlock;

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function leftShiftOneBit(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const value = (buf[i] << 1) | carry;
    out[i] = value & 0xff;
    carry = (value >> 8) & 1;
  }
  return out;
}

function generateSubkeys(key) {
  const l = aesEcbEncryptBlock(key, ZERO16);
  const msb = l[0] & 0x80;
  let k1 = leftShiftOneBit(l);
  if (msb) k1[15] ^= Number(RB);
  const msb1 = k1[0] & 0x80;
  let k2 = leftShiftOneBit(k1);
  if (msb1) k2[15] ^= Number(RB);
  return { k1, k2 };
}

// AES-CMAC (RFC 4493), clé 128 bits, message de longueur quelconque (y compris vide).
export function aesCmac(key, message) {
  const { k1, k2 } = generateSubkeys(key);
  const n = message.length === 0 ? 1 : Math.ceil(message.length / 16);
  const lastBlockComplete = message.length !== 0 && message.length % 16 === 0;

  let lastBlock;
  if (lastBlockComplete) {
    lastBlock = xorBuffers(message.subarray((n - 1) * 16, n * 16), k1);
  } else {
    const remainder = message.subarray((n - 1) * 16);
    const padded = Buffer.concat([remainder, Buffer.from([0x80]), Buffer.alloc(16 - remainder.length - 1)]);
    lastBlock = xorBuffers(padded, k2);
  }

  let x = ZERO16;
  for (let i = 0; i < n - 1; i++) {
    const block = message.subarray(i * 16, (i + 1) * 16);
    x = aesEcbEncryptBlock(key, xorBuffers(x, block));
  }
  return aesEcbEncryptBlock(key, xorBuffers(x, lastBlock));
}

// s1(M) = AES-CMAC(ZERO, M)
export function s1(message) {
  return aesCmac(ZERO16, Buffer.isBuffer(message) ? message : Buffer.from(message));
}

// k1(N, SALT, P) = AES-CMAC(AES-CMAC(SALT, N), P)
export function k1(n, salt, p) {
  const t = aesCmac(salt, n);
  return aesCmac(t, p);
}

function bufConcat(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

// k2(N, P) -> { nid, encryptionKey, privacyKey } (dérivation des clés réseau depuis la NetKey)
export function k2(n, p) {
  const salt = s1(Buffer.from('smk2', 'ascii'));
  const t = aesCmac(salt, n);
  const t1 = aesCmac(t, bufConcat(p, Buffer.from([0x01])));
  const t2 = aesCmac(t, bufConcat(t1, p, Buffer.from([0x02])));
  const t3 = aesCmac(t, bufConcat(t2, p, Buffer.from([0x03])));
  const full = bufConcat(t1, t2, t3); // 48 octets, on garde les 33 derniers (1 + 16 + 16)
  const relevant = full.subarray(full.length - 33);
  return {
    nid: relevant[0] & 0x7f,
    encryptionKey: relevant.subarray(1, 17),
    privacyKey: relevant.subarray(17, 33)
  };
}

// k3(N) -> Network ID (8 octets)
export function k3(n) {
  const salt = s1(Buffer.from('smk3', 'ascii'));
  const t = aesCmac(salt, n);
  const full = aesCmac(t, Buffer.from('id64\x01', 'binary'));
  return full.subarray(full.length - 8);
}

// k4(N) -> AID (6 bits, dérivé de l'AppKey)
export function k4(n) {
  const salt = s1(Buffer.from('smk4', 'ascii'));
  const t = aesCmac(salt, n);
  const full = aesCmac(t, Buffer.from('id6\x01', 'binary'));
  return full[full.length - 1] & 0x3f;
}

// Electron est lié à BoringSSL et n'expose pas `aes-128-ccm` via node:crypto,
// contrairement au runtime Node/OpenSSL utilisé par les tests et les scripts. CCM
// est donc construit ici au-dessus du seul bloc AES-128-ECB, disponible dans les deux
// runtimes. Le profil Bluetooth Mesh n'utilise pas d'AAD, impose un nonce de 13 octets
// (L=2) et des MIC de 4 ou 8 octets selon la couche.
const CCM_NONCE_LENGTH = 13;
const CCM_LENGTH_FIELD_BYTES = 15 - CCM_NONCE_LENGTH;
const CCM_MAX_PAYLOAD_LENGTH = (2 ** (8 * CCM_LENGTH_FIELD_BYTES)) - 1;
const CCM_MIC_LENGTHS = new Set([4, 8]);

function assertBuffer(value, label) {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${label} doit être un Buffer`);
}

function validateCcmParameters(key, nonce, payload, micLength) {
  assertBuffer(key, 'La clé AES-CCM');
  assertBuffer(nonce, 'Le nonce AES-CCM');
  assertBuffer(payload, 'Le payload AES-CCM');
  if (key.length !== 16) throw new RangeError('La clé AES-CCM doit contenir exactement 16 octets');
  if (nonce.length !== CCM_NONCE_LENGTH) {
    throw new RangeError(`Le nonce AES-CCM Bluetooth Mesh doit contenir exactement ${CCM_NONCE_LENGTH} octets`);
  }
  if (!Number.isInteger(micLength) || !CCM_MIC_LENGTHS.has(micLength)) {
    throw new RangeError('La MIC AES-CCM Bluetooth Mesh doit contenir 4 ou 8 octets');
  }
  if (payload.length > CCM_MAX_PAYLOAD_LENGTH) {
    throw new RangeError(`Le payload AES-CCM dépasse ${CCM_MAX_PAYLOAD_LENGTH} octets pour un nonce de ${CCM_NONCE_LENGTH} octets`);
  }
}

function encodeCcmInteger(value, byteLength) {
  const encoded = Buffer.alloc(byteLength);
  let remaining = value;
  for (let index = byteLength - 1; index >= 0; index--) {
    encoded[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  if (remaining !== 0) throw new RangeError(`Entier CCM trop grand pour ${byteLength} octets`);
  return encoded;
}

function createCcmControlBlock(nonce, counter, micLength = null) {
  const block = Buffer.alloc(16);
  const lengthField = CCM_LENGTH_FIELD_BYTES - 1;
  block[0] = micLength == null
    ? lengthField
    : ((((micLength - 2) / 2) << 3) | lengthField);
  nonce.copy(block, 1);
  encodeCcmInteger(counter, CCM_LENGTH_FIELD_BYTES).copy(block, 1 + nonce.length);
  return block;
}

function computeCcmMac(key, nonce, plaintext, micLength) {
  const b0 = createCcmControlBlock(nonce, plaintext.length, micLength);
  let state = aesEcbEncryptBlock(key, b0);
  for (let offset = 0; offset < plaintext.length; offset += 16) {
    const block = Buffer.alloc(16);
    plaintext.copy(block, 0, offset, Math.min(offset + 16, plaintext.length));
    state = aesEcbEncryptBlock(key, xorBuffers(state, block));
  }
  return state.subarray(0, micLength);
}

function applyCcmCounterMode(key, nonce, input) {
  const output = Buffer.alloc(input.length);
  for (let offset = 0, counter = 1; offset < input.length; offset += 16, counter++) {
    const stream = aesEcbEncryptBlock(key, createCcmControlBlock(nonce, counter));
    const blockLength = Math.min(16, input.length - offset);
    for (let index = 0; index < blockLength; index++) {
      output[offset + index] = input[offset + index] ^ stream[index];
    }
  }
  return output;
}

function encryptCcmMic(key, nonce, plaintext, micLength) {
  const clearMic = computeCcmMac(key, nonce, plaintext, micLength);
  const s0 = aesEcbEncryptBlock(key, createCcmControlBlock(nonce, 0));
  return xorBuffers(clearMic, s0.subarray(0, micLength));
}

export function aesCcmEncrypt(key, nonce, plaintext, micLength = 4) {
  validateCcmParameters(key, nonce, plaintext, micLength);
  return {
    ciphertext: applyCcmCounterMode(key, nonce, plaintext),
    mic: encryptCcmMic(key, nonce, plaintext, micLength)
  };
}

export function aesCcmDecrypt(key, nonce, ciphertext, mic, micLength = 4) {
  validateCcmParameters(key, nonce, ciphertext, micLength);
  assertBuffer(mic, 'La MIC AES-CCM');
  if (mic.length !== micLength) {
    throw new RangeError(`La MIC AES-CCM doit contenir exactement ${micLength} octets`);
  }
  const plaintext = applyCcmCounterMode(key, nonce, ciphertext);
  const expectedMic = encryptCcmMic(key, nonce, plaintext, micLength);
  if (!crypto.timingSafeEqual(expectedMic, mic)) {
    // Conserve la formulation `unable to authenticate data` de node:crypto afin que
    // les appelants qui reconnaissaient déjà cette famille d'erreurs restent compatibles.
    const error = new Error('Authentification AES-CCM invalide : unable to authenticate data (MIC incorrecte)');
    error.code = 'ERR_CRYPTO_INVALID_AUTH_TAG';
    throw error;
  }
  return plaintext;
}

// Échange ECDH P-256 du provisioning (FIPS P-256, cf. §4 RM75_SPEC_DEV.md).
export function generateProvisioningKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const uncompressed = ecdh.getPublicKey(); // 0x04 || X(32) || Y(32)
  return {
    ecdh,
    publicKeyXY: uncompressed.subarray(1) // X(32) || Y(32), format attendu par le PDU Public Key
  };
}

// Recompose une clé publique 0x04||X||Y à partir des 64 octets X||Y reçus du device.
export function computeSharedSecret(ecdh, peerPublicKeyXY) {
  const uncompressed = Buffer.concat([Buffer.from([0x04]), peerPublicKeyXY]);
  return ecdh.computeSecret(uncompressed); // coordonnée X (32 octets)
}

export function randomBytes(length) {
  return crypto.randomBytes(length);
}
