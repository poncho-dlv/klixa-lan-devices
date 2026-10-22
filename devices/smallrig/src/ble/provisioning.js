// Provisioning PB-GATT (RM75_SPEC_DEV.md §4). Implémente le rôle Provisioner : gère la
// séquence Invite -> Capabilities -> Start -> Public Key -> Confirmation -> Random ->
// Data -> Complete, et les dérivations cryptographiques associées.
//
// Découplé du transport BLE réel : `transport` est injecté (voir ble-transport.js pour
// l'implémentation matérielle), ce qui permet de tester toute la logique de dérivation
// de clés en simulant les deux extrémités en mémoire (tests/smallrig-provisioning.test.js).

import { aesCcmDecrypt, aesCcmEncrypt, aesCmac, computeSharedSecret, generateProvisioningKeyPair, k1, randomBytes, s1 } from './mesh-crypto.js';

export const PROVISIONING_PDU_TYPE = {
  INVITE: 0x00,
  CAPABILITIES: 0x01,
  START: 0x02,
  PUBLIC_KEY: 0x03,
  INPUT_COMPLETE: 0x04,
  CONFIRMATION: 0x05,
  RANDOM: 0x06,
  DATA: 0x07,
  COMPLETE: 0x08,
  FAILED: 0x09
};

// La RM75 n'a pas encore démontré de canal OOB exploitable par le compagnon. No-OOB
// protège l'intégrité de l'échange, mais NE protège PAS contre un MITM actif.
const NO_OOB_AUTH_VALUE = Buffer.alloc(16);

export function encodeInvite(attentionDurationS = 0) {
  return Buffer.from([attentionDurationS & 0xff]);
}

export function decodeCapabilities(bytes) {
  if (bytes.length < 11) throw new Error('Capabilities PDU trop court');
  return {
    numElements: bytes[0],
    algorithms: (bytes[1] << 8) | bytes[2],
    publicKeyType: bytes[3],
    staticOobType: bytes[4],
    outputOobSize: bytes[5],
    outputOobAction: (bytes[6] << 8) | bytes[7],
    inputOobSize: bytes[8],
    inputOobAction: (bytes[9] << 8) | bytes[10]
  };
}

export function validateNoOobCapabilities(capabilities) {
  if (!Number.isInteger(capabilities.numElements) || capabilities.numElements < 1) {
    throw new Error('Capabilities invalides : le device doit annoncer au moins un élément');
  }
  // Algorithms bit 0 = FIPS P-256 Elliptic Curve, seul algorithme implémenté ici.
  if ((capabilities.algorithms & 0x0001) === 0) {
    throw new Error('Capabilities incompatibles : FIPS P-256 non supporté');
  }
  if (capabilities.outputOobSize < 0 || capabilities.outputOobSize > 8
      || capabilities.inputOobSize < 0 || capabilities.inputOobSize > 8) {
    throw new Error('Capabilities invalides : taille OOB hors plage');
  }
  if (capabilities.outputOobSize === 0 && capabilities.outputOobAction !== 0) {
    throw new Error('Capabilities invalides : actions Output OOB sans taille associée');
  }
  if (capabilities.inputOobSize === 0 && capabilities.inputOobAction !== 0) {
    throw new Error('Capabilities invalides : actions Input OOB sans taille associée');
  }
  return capabilities;
}

// Start PDU : FIPS P-256, pas de clé publique OOB, authentification No-OOB. Cette
// sélection est explicite et validée contre les Capabilities avant émission.
export function encodeStart({ algorithm = 0x00, publicKeyType = 0x00, authMethod = 0x00, authAction = 0x00, authSize = 0x00 } = {}) {
  return Buffer.from([algorithm, publicKeyType, authMethod, authAction, authSize]);
}

function u16(value) {
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  return Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

// Provisioning Data en clair (25 octets, §4).
export function encodeProvisioningDataPlaintext({ netKey, keyIndex = 0, flags = 0, ivIndex = 0, unicastAddress }) {
  return Buffer.concat([netKey, u16(keyIndex), Buffer.from([flags]), u32(ivIndex), u16(unicastAddress)]);
}

export function decodeProvisioningDataPlaintext(bytes) {
  return {
    netKey: bytes.subarray(0, 16),
    keyIndex: (bytes[16] << 8) | bytes[17],
    flags: bytes[18],
    ivIndex: (bytes[19] << 24) | (bytes[20] << 16) | (bytes[21] << 8) | bytes[22],
    unicastAddress: (bytes[23] << 8) | bytes[24]
  };
}

// Exécute le rôle Provisioner complet. `transport` : { send(typeByte, params):Promise,
// receive(expectedType):Promise<Buffer> } — déjà branché sur le Proxy PDU (§2) et la
// connexion GATT au service Provisioning (0x1827) côté appelant (mesh-client.js).
//
// `unicastAddress` peut être soit un nombre (adresse déjà connue), soit une fonction
// `(capabilities) => number` : le nombre d'éléments du nœud (donc la taille du bloc
// d'adresses à réserver) n'est connu qu'à réception des Capabilities, en plein milieu
// de la séquence — cf. mesh-client.js pour l'allocation réelle via mesh-store.js.
export async function runProvisioning({
  transport,
  netKey,
  keyIndex = 0,
  ivIndex = 0,
  unicastAddress,
  attentionDurationS = 0,
  onBeforeData,
  encryptProvisioningData = aesCcmEncrypt
}) {
  // Cette information d'incertitude traverse la frontière d'orchestration jusqu'au
  // mesh-client : avant le premier appel send(DATA), la lampe ne peut pas avoir reçu
  // les clés Mesh. Dès que cet appel commence, une erreur de transport peut en revanche
  // survenir après un envoi partiel et doit rester traitée comme incertaine.
  let provisioningDataMayHaveBeenSent = false;
  try {
    const invite = encodeInvite(attentionDurationS);
    await transport.send(PROVISIONING_PDU_TYPE.INVITE, invite);

    const capabilitiesRaw = await transport.receive(PROVISIONING_PDU_TYPE.CAPABILITIES);
    const capabilities = validateNoOobCapabilities(decodeCapabilities(capabilitiesRaw));
    const resolvedUnicastAddress = typeof unicastAddress === 'function' ? unicastAddress(capabilities) : unicastAddress;

    const start = encodeStart();
    await transport.send(PROVISIONING_PDU_TYPE.START, start);

    const provisioner = generateProvisioningKeyPair();
    await transport.send(PROVISIONING_PDU_TYPE.PUBLIC_KEY, provisioner.publicKeyXY);
    const devicePublicKeyXY = await transport.receive(PROVISIONING_PDU_TYPE.PUBLIC_KEY);

    const ecdhSecret = computeSharedSecret(provisioner.ecdh, devicePublicKeyXY);

    const confirmationInputs = Buffer.concat([invite, capabilitiesRaw, start, provisioner.publicKeyXY, devicePublicKeyXY]);
    const confirmationSalt = s1(confirmationInputs);
    const confirmationKey = k1(ecdhSecret, confirmationSalt, Buffer.from('prck', 'ascii'));

    const randomProvisioner = randomBytes(16);
    const confirmationProvisioner = aesCmac(confirmationKey, Buffer.concat([randomProvisioner, NO_OOB_AUTH_VALUE]));
    await transport.send(PROVISIONING_PDU_TYPE.CONFIRMATION, confirmationProvisioner);
    const confirmationDeviceReceived = await transport.receive(PROVISIONING_PDU_TYPE.CONFIRMATION);

    await transport.send(PROVISIONING_PDU_TYPE.RANDOM, randomProvisioner);
    const randomDevice = await transport.receive(PROVISIONING_PDU_TYPE.RANDOM);

    const confirmationDeviceExpected = aesCmac(confirmationKey, Buffer.concat([randomDevice, NO_OOB_AUTH_VALUE]));
    if (!confirmationDeviceExpected.equals(confirmationDeviceReceived)) {
      throw new Error('Confirmation cryptographique du device invalide — abandon du provisioning');
    }

    const provisioningSalt = s1(Buffer.concat([confirmationSalt, randomProvisioner, randomDevice]));
    const sessionKey = k1(ecdhSecret, provisioningSalt, Buffer.from('prsk', 'ascii'));
    const sessionNonceFull = k1(ecdhSecret, provisioningSalt, Buffer.from('prsn', 'ascii'));
    const sessionNonce = sessionNonceFull.subarray(sessionNonceFull.length - 13); // 13 derniers octets
    const deviceKey = k1(ecdhSecret, provisioningSalt, Buffer.from('prdk', 'ascii'));

    // Préparer entièrement le PDU chiffré AVANT de journaliser la DevKey. Certaines
    // distributions Electron ne proposent pas AES-CCM dans leur backend crypto : si la
    // préparation échoue, rien n'a été persisté et la lampe est encore assurément non
    // provisionnée. L'invariant durable reste inchangé : journal puis send(DATA).
    const plaintext = encodeProvisioningDataPlaintext({ netKey, keyIndex, flags: 0, ivIndex, unicastAddress: resolvedUnicastAddress });
    const { ciphertext, mic } = encryptProvisioningData(sessionKey, sessionNonce, plaintext, 8);
    const provisioningDataPdu = Buffer.concat([ciphertext, mic]);

    // La DevKey et l'adresse sont désormais récupérables. Le callback doit être durable
    // avant Provisioning Data : après cet envoi, un crash ou la perte de Complete peut
    // laisser le device provisionné sans autre moyen de reconstruire sa DevKey.
    if (onBeforeData) {
      await onBeforeData({
        deviceKey,
        unicastAddress: resolvedUnicastAddress,
        numElements: capabilities.numElements,
        capabilities,
        authenticationMethod: 'no-oob',
        authenticationMitmProtected: false
      });
    }

    provisioningDataMayHaveBeenSent = true;
    await transport.send(PROVISIONING_PDU_TYPE.DATA, provisioningDataPdu);

    await transport.receive(PROVISIONING_PDU_TYPE.COMPLETE);

    return {
      deviceKey,
      unicastAddress: resolvedUnicastAddress,
      numElements: capabilities.numElements,
      capabilities,
      authenticationMethod: 'no-oob',
      authenticationMitmProtected: false
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.provisioningDataMayHaveBeenSent === undefined) {
      Object.defineProperty(error, 'provisioningDataMayHaveBeenSent', {
        value: provisioningDataMayHaveBeenSent,
        enumerable: false,
        configurable: true
      });
    }
    throw error;
  }
}

// Côté device (utilisé uniquement pour tester le Provisioner ci-dessus en simulant les
// deux extrémités en mémoire — jamais utilisé en production, la RM75 implémente ce
// rôle dans son firmware).
export async function simulateDeviceSide({ transport, capabilities, expectComplete = true }) {
  const inviteRaw = await transport.receive(PROVISIONING_PDU_TYPE.INVITE);
  const capabilitiesRaw = Buffer.from([
    capabilities.numElements, (capabilities.algorithms >> 8) & 0xff, capabilities.algorithms & 0xff,
    capabilities.publicKeyType, capabilities.staticOobType, capabilities.outputOobSize,
    (capabilities.outputOobAction >> 8) & 0xff, capabilities.outputOobAction & 0xff,
    capabilities.inputOobSize, (capabilities.inputOobAction >> 8) & 0xff, capabilities.inputOobAction & 0xff
  ]);
  await transport.send(PROVISIONING_PDU_TYPE.CAPABILITIES, capabilitiesRaw);

  const startRaw = await transport.receive(PROVISIONING_PDU_TYPE.START);

  const device = generateProvisioningKeyPair();
  const provisionerPublicKeyXY = await transport.receive(PROVISIONING_PDU_TYPE.PUBLIC_KEY);
  await transport.send(PROVISIONING_PDU_TYPE.PUBLIC_KEY, device.publicKeyXY);

  const ecdhSecret = computeSharedSecret(device.ecdh, provisionerPublicKeyXY);
  const confirmationInputs = Buffer.concat([inviteRaw, capabilitiesRaw, startRaw, provisionerPublicKeyXY, device.publicKeyXY]);
  const confirmationSalt = s1(confirmationInputs);
  const confirmationKey = k1(ecdhSecret, confirmationSalt, Buffer.from('prck', 'ascii'));

  const confirmationProvisionerReceived = await transport.receive(PROVISIONING_PDU_TYPE.CONFIRMATION);
  const randomDevice = randomBytes(16);
  const confirmationDevice = aesCmac(confirmationKey, Buffer.concat([randomDevice, NO_OOB_AUTH_VALUE]));
  await transport.send(PROVISIONING_PDU_TYPE.CONFIRMATION, confirmationDevice);

  const randomProvisioner = await transport.receive(PROVISIONING_PDU_TYPE.RANDOM);
  const confirmationProvisionerExpected = aesCmac(confirmationKey, Buffer.concat([randomProvisioner, NO_OOB_AUTH_VALUE]));
  if (!confirmationProvisionerExpected.equals(confirmationProvisionerReceived)) {
    throw new Error('Confirmation du provisioner invalide (simulation)');
  }
  await transport.send(PROVISIONING_PDU_TYPE.RANDOM, randomDevice);

  const provisioningSalt = s1(Buffer.concat([confirmationSalt, randomProvisioner, randomDevice]));
  const sessionKey = k1(ecdhSecret, provisioningSalt, Buffer.from('prsk', 'ascii'));
  const sessionNonceFull = k1(ecdhSecret, provisioningSalt, Buffer.from('prsn', 'ascii'));
  const sessionNonce = sessionNonceFull.subarray(sessionNonceFull.length - 13);
  const deviceKey = k1(ecdhSecret, provisioningSalt, Buffer.from('prdk', 'ascii'));

  const dataRaw = await transport.receive(PROVISIONING_PDU_TYPE.DATA);
  const ciphertext = dataRaw.subarray(0, dataRaw.length - 8);
  const mic = dataRaw.subarray(dataRaw.length - 8);
  const plaintext = aesCcmDecrypt(sessionKey, sessionNonce, ciphertext, mic, 8);
  const provisioningData = decodeProvisioningDataPlaintext(plaintext);

  if (expectComplete) await transport.send(PROVISIONING_PDU_TYPE.COMPLETE, Buffer.alloc(0));

  return { deviceKey, provisioningData };
}
