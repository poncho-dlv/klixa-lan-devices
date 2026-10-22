// Messages de configuration standard Bluetooth Mesh nécessaires après provisioning
// (RM75_SPEC_DEV.md §8) : Composition Data Get/Status, App Key Add/Status, Model App
// Bind/Status. Chiffrés avec la DevKey du nœud (AKF=0), cf. transport-layer.js.

export const CONFIG_OPCODE = {
  APP_KEY_ADD: 0x00,
  COMPOSITION_DATA_STATUS: 0x02,
  COMPOSITION_DATA_GET: 0x8008,
  APP_KEY_STATUS: 0x8003,
  MODEL_APP_BIND: 0x803d,
  MODEL_APP_STATUS: 0x803e
};

// Encode un opcode d'accès (1 ou 2 octets — les opcodes vendor 3 octets sont gérés à
// part par lq-protocol.js#buildVendorAccessPayload).
export function encodeConfigOpcode(value) {
  if (value < 0x100) return Buffer.from([value]);
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

// Décode l'opcode en tête d'un Access Payload reçu, selon les règles standard
// (1er octet < 0x80 -> opcode 1 octet ; 0x80-0xBF -> opcode 2 octets ; 0xC0-0xFF ->
// opcode vendor 3 octets).
export function decodeAccessOpcode(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || []);
  if (bytes.length < 1) throw new Error('Access Payload vide');
  const first = bytes[0];
  if (first < 0x80) return { opcode: first, length: 1, isVendor: false, params: bytes.subarray(1) };
  if (first < 0xc0) {
    if (bytes.length < 2) throw new Error('Opcode Access 2 octets tronqué');
    return { opcode: (bytes[0] << 8) | bytes[1], length: 2, isVendor: false, params: bytes.subarray(2) };
  }
  if (bytes.length < 3) throw new Error('Opcode Access vendor tronqué');
  return { opcode: null, length: 3, isVendor: true, vendorOpcodeByte: bytes[0], vendorCid: bytes[1] | (bytes[2] << 8), params: bytes.subarray(3) };
}

export function encodeCompositionDataGet(page = 0) {
  return Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.COMPOSITION_DATA_GET), Buffer.from([page])]);
}

// Analyse minimale de la Composition Data Status (page 0) : uniquement ce qui sert à
// vérifier la présence du vendor model DATATRANS_SERVER sur le 1er élément (§8, §12
// point 4 — vérification optionnelle, pas bloquante pour le fonctionnement).
export function parseCompositionDataPage0(params) {
  if (params.length < 11) throw new Error('Composition Data Status trop courte');
  if (params[0] !== 0x00) throw new Error(`Composition Data Status page inattendue (${params[0]})`);
  // page(1) + CID(2) + PID(2) + VID(2) + CRPL(2) + Features(2) = 11 octets d'en-tête
  let offset = 11;
  const elements = [];
  while (offset < params.length) {
    if (offset + 4 > params.length) throw new Error('Composition Data : en-tête élément tronqué');
    // Location(2) + NumS(1) + NumV(1)
    const location = params.readUInt16LE(offset);
    offset += 2;
    const numS = params[offset]; offset += 1;
    const numV = params[offset]; offset += 1;
    if (offset + numS * 2 + numV * 4 > params.length) throw new Error('Composition Data : liste de modèles tronquée');
    const sigModels = [];
    for (let i = 0; i < numS && offset + 2 <= params.length; i++) {
      sigModels.push(params.readUInt16LE(offset));
      offset += 2;
    }
    const vendorModels = [];
    for (let i = 0; i < numV && offset + 4 <= params.length; i++) {
      const cid = params.readUInt16LE(offset);
      const modelId = params.readUInt16LE(offset + 2);
      // Convention doc (§8) : le ModelId "logique" 4 octets = ModelID(16 bits haut) |
      // CID(16 bits bas), ex. 0x0004005D = ModelID 0x0004 + CID 0x005D.
      vendorModels.push((modelId << 16) | cid);
      offset += 4;
    }
    elements.push({ location, sigModels, vendorModels });
  }
  return { page: 0, elements };
}

export function encodeAppKeyAdd({ netKeyIndex = 0, appKeyIndex = 0, appKey }) {
  const packedIndex = Buffer.from([
    netKeyIndex & 0xff,
    ((appKeyIndex & 0x0f) << 4) | ((netKeyIndex >> 8) & 0x0f),
    (appKeyIndex >> 4) & 0xff
  ]);
  return Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.APP_KEY_ADD), packedIndex, appKey]);
}

export function decodeAppKeyStatus(params) {
  if (params.length !== 4) throw new Error('App Key Status mal formé');
  const netKeyIndex = params[1] | ((params[2] & 0x0f) << 8);
  const appKeyIndex = ((params[2] >> 4) & 0x0f) | (params[3] << 4);
  return { status: params[0], ok: params[0] === 0x00, netKeyIndex, appKeyIndex };
}

export function encodeModelAppBind({ elementAddress, appKeyIndex = 0, modelId, isVendorModel = true }) {
  const modelIdBuf = isVendorModel
    ? Buffer.from([modelId & 0xff, (modelId >> 8) & 0xff, (modelId >> 16) & 0xff, (modelId >> 24) & 0xff])
    : Buffer.from([modelId & 0xff, (modelId >> 8) & 0xff]);
  return Buffer.concat([
    encodeConfigOpcode(CONFIG_OPCODE.MODEL_APP_BIND),
    Buffer.from([elementAddress & 0xff, (elementAddress >> 8) & 0xff]),
    Buffer.from([appKeyIndex & 0xff, (appKeyIndex >> 8) & 0xff]),
    modelIdBuf
  ]);
}

export function decodeModelAppStatus(params) {
  if (params.length !== 7 && params.length !== 9) throw new Error('Model App Status mal formé');
  const isVendorModel = params.length === 9;
  return {
    status: params[0],
    ok: params[0] === 0x00,
    elementAddress: params.readUInt16LE(1),
    appKeyIndex: params.readUInt16LE(3) & 0x0fff,
    modelId: isVendorModel ? params.readUInt32LE(5) : params.readUInt16LE(5),
    isVendorModel
  };
}
