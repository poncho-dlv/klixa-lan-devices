import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aesCcmDecrypt,
  aesCcmEncrypt,
  aesCmac,
  computeSharedSecret,
  generateProvisioningKeyPair,
  k1,
  k2,
  k3,
  k4,
  s1
} from '../src/ble/mesh-crypto.js';

const RFC4493_KEY = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const RFC4493_MSG = Buffer.from(
  '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52ef' +
  'f69f2445df4f9b17ad2b417be66c3710',
  'hex'
);

test('aesCmac: vecteurs officiels RFC 4493 §4', () => {
  assert.equal(aesCmac(RFC4493_KEY, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 16)).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 40)).toString('hex'), 'dfa66747de9ae63030ca32611497c827');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 64)).toString('hex'), '51f0bebf7e3b9d92fc49741779363cfe');
});

test('s1: longueur de sortie 16 octets, déterministe', () => {
  const out = s1('test');
  assert.equal(out.length, 16);
  assert.deepEqual(out, s1('test'));
  assert.notDeepEqual(out, s1('autre'));
});

test('k2: NID sur 7 bits, EncryptionKey/PrivacyKey 16 octets chacune, déterministe', () => {
  const netKey = Buffer.from('f7a2a44f8e8a8029064f173ddc1e2b00', 'hex');
  const { nid, encryptionKey, privacyKey } = k2(netKey, Buffer.from([0x00]));
  assert.ok(nid >= 0 && nid <= 0x7f);
  assert.equal(encryptionKey.length, 16);
  assert.equal(privacyKey.length, 16);
  const again = k2(netKey, Buffer.from([0x00]));
  assert.deepEqual(again, { nid, encryptionKey, privacyKey });
});

test('k3: Network ID sur 8 octets', () => {
  const netKey = Buffer.from('f7a2a44f8e8a8029064f173ddc1e2b00', 'hex');
  const id = k3(netKey);
  assert.equal(id.length, 8);
});

test('k4: AID sur 6 bits (0..63)', () => {
  const appKey = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff));
  const aid = k4(appKey);
  assert.ok(aid >= 0 && aid <= 0x3f);
});

test('k1: dérive une clé de session déterministe de 16 octets', () => {
  const secret = Buffer.alloc(32, 0xab);
  const salt = s1(Buffer.from('ConfirmationSalt-test'));
  const derived = k1(secret, salt, Buffer.from('prsk'));
  assert.equal(derived.length, 16);
  assert.deepEqual(derived, k1(secret, salt, Buffer.from('prsk')));
});

test('AES-CCM: vecteurs fixes sans AAD, MIC 4 et 8 octets', () => {
  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const nonce = Buffer.from('00112233445566778899aabbcc', 'hex'); // 13 octets
  const vectors = [
    { plaintext: '', micLength: 4, ciphertext: '', mic: '179dc5fd' },
    { plaintext: '2433040000006464', micLength: 4, ciphertext: '08f799300f3fae2d', mic: '1c0c6073' },
    { plaintext: '2433040000006464', micLength: 8, ciphertext: '08f799300f3fae2d', mic: '0a8a4266bf76afbd' },
    {
      // Longueur exacte du Provisioning Data Bluetooth Mesh.
      plaintext: '000102030405060708090a0b0c0d0e0f101112131415161718',
      micLength: 8,
      ciphertext: '2cc59f330b3acc4e0c1d5d5fae7eff493f984d3a767f96b5d9',
      mic: 'd08105772aa3e6a4'
    }
  ];

  for (const vector of vectors) {
    const plaintext = Buffer.from(vector.plaintext, 'hex');
    const micLength = vector.micLength;
    const { ciphertext, mic } = aesCcmEncrypt(key, nonce, plaintext, micLength);
    assert.equal(ciphertext.toString('hex'), vector.ciphertext);
    assert.equal(mic.toString('hex'), vector.mic);
    assert.deepEqual(aesCcmDecrypt(key, nonce, ciphertext, mic, micLength), plaintext);
  }
});

test('AES-CCM: une MIC ou un ciphertext altéré fait échouer l\'authentification', () => {
  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const nonce = Buffer.from('00112233445566778899aabbcc', 'hex');
  const { ciphertext, mic } = aesCcmEncrypt(key, nonce, Buffer.from('hello mesh'), 4);
  const tamperedMic = Buffer.from(mic);
  tamperedMic[0] ^= 0xff;
  assert.throws(
    () => aesCcmDecrypt(key, nonce, ciphertext, tamperedMic, 4),
    (error) => error.code === 'ERR_CRYPTO_INVALID_AUTH_TAG'
  );

  const tamperedCiphertext = Buffer.from(ciphertext);
  tamperedCiphertext[0] ^= 0xff;
  assert.throws(
    () => aesCcmDecrypt(key, nonce, tamperedCiphertext, mic, 4),
    (error) => error.code === 'ERR_CRYPTO_INVALID_AUTH_TAG'
  );
});

test('AES-CCM: valide strictement clé, nonce, payload et longueur de MIC Bluetooth Mesh', () => {
  const key = Buffer.alloc(16);
  const nonce = Buffer.alloc(13);
  const payload = Buffer.alloc(0);

  assert.throws(() => aesCcmEncrypt(new Uint8Array(16), nonce, payload), /clé AES-CCM.*Buffer/);
  assert.throws(() => aesCcmEncrypt(Buffer.alloc(15), nonce, payload), /exactement 16 octets/);
  assert.throws(() => aesCcmEncrypt(key, Buffer.alloc(12), payload), /exactement 13 octets/);
  assert.throws(() => aesCcmEncrypt(key, nonce, new Uint8Array(0)), /payload AES-CCM.*Buffer/);
  assert.throws(() => aesCcmEncrypt(key, nonce, payload, 6), /4 ou 8 octets/);
  assert.throws(() => aesCcmEncrypt(key, nonce, Buffer.alloc(65536), 8), /dépasse 65535 octets/);

  const { ciphertext, mic } = aesCcmEncrypt(key, nonce, payload, 8);
  assert.throws(() => aesCcmDecrypt(key, nonce, ciphertext, new Uint8Array(mic), 8), /MIC AES-CCM.*Buffer/);
  assert.throws(() => aesCcmDecrypt(key, nonce, ciphertext, Buffer.alloc(4), 8), /exactement 8 octets/);
});

test('ECDH P-256: les deux parties dérivent le même secret partagé', () => {
  const alice = generateProvisioningKeyPair();
  const bob = generateProvisioningKeyPair();
  assert.equal(alice.publicKeyXY.length, 64);
  assert.equal(bob.publicKeyXY.length, 64);

  const secretFromAlice = computeSharedSecret(alice.ecdh, bob.publicKeyXY);
  const secretFromBob = computeSharedSecret(bob.ecdh, alice.publicKeyXY);
  assert.equal(secretFromAlice.length, 32);
  assert.deepEqual(secretFromAlice, secretFromBob);
});
