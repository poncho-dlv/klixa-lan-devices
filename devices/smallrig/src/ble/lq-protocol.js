// Protocole applicatif "Lq" des lampes SmallRig RM75 (com.iton.meshlib.rtk.lq.*),
// cf. RM75_SPEC_DEV.md §9 et RM75_protocole.md §2-5. Couche pure : encode/décode des
// trames applicatives, indépendante du transport BLE et des couches mesh (network,
// transport). Entièrement testée sans matériel (tests/smallrig-lq-protocol.test.js).

export const LQ_OPCODE = {
  CAPACITY: 0x31,
  VERSION: 0x32,
  HSI: 0x33,
  CCT: 0x34,
  FX: 0x35,
  RGBW: 0x36,
  MANUAL_CCT: 0x37,
  MANUAL_HSI: 0x38,
  PICKUP: 0x39,
  LUM: 0x42,
  STATUS: 0x43
};

export const LQ_LUM_SENTINEL = { ON: 0xfe00, OFF: 0xfc00 };

export const FX_MODE = {
  PAPARAZZI: 1, CYCLE: 2, LIGHTNING: 3, PULSING: 4, SOS: 5, WELDING: 6, ALARM: 7,
  FIREWORKS: 8, RANDOM: 9, FIRE: 10, TV: 11, FAULT_BULB: 12
};

// Company ID Realtek Semiconductor, utilisé pour l'opcode vendor 3 octets (§9).
export const VENDOR_CID = 0x005d;
// Sous-opcode vendor "data" observé dans FuMeshManager/LqVendorClient.
export const VENDOR_SUBOPCODE_DATA = 0x24;

function xorAll(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x & 0xff;
}

export function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// Format "commande de contrôle" : [opcode][len][xor][payload...] (§2/§9).
export function encodeControlFrame(opcode, payload) {
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([opcode, body.length, xorAll(body)]), body]);
}

// Format "lecture" (cmd.c == false) : [opcode] seul, sans payload.
export function encodeReadFrame(opcode) {
  return Buffer.from([opcode]);
}

export function encodeHsi({ hue, sat, intensity }) {
  const h = clampInt(hue, 0, 360);
  const s = clampInt(sat, 0, 100);
  const i = clampInt(intensity, 0, 100);
  return encodeControlFrame(LQ_OPCODE.HSI, [(h >> 8) & 0xff, h & 0xff, s, i]);
}

export function encodeCct({ kelvin, intensity, gm = 0 }) {
  const k = clampInt(kelvin, 0, 0xffff);
  const i = clampInt(intensity, 0, 100);
  const g = clampInt(gm, -10, 10);
  return encodeControlFrame(LQ_OPCODE.CCT, [(k >> 8) & 0xff, k & 0xff, i, (g + 10) * 5]);
}

export function encodeRgbw({ r, g, b, w = 0 }) {
  return encodeControlFrame(LQ_OPCODE.RGBW, [clampInt(r, 0, 255), clampInt(g, 0, 255), clampInt(b, 0, 255), clampInt(w, 0, 255)]);
}

// Format confirmé dans SmallGoGo/LqFx :
// - mode 1 : [mode, 5, p1, p2_hi, p2_lo]
// - modes 3/6/8/11/12 : [mode, 5, p1]
// - autres modes : [mode, 5, p1, p2]
const FX_ONE_PARAMETER_MODES = new Set([
  FX_MODE.LIGHTNING,
  FX_MODE.WELDING,
  FX_MODE.FIREWORKS,
  FX_MODE.TV,
  FX_MODE.FAULT_BULB
]);

export function encodeFx({ mode, param1 = 0, param2 = 0 }) {
  const m = clampInt(mode, 1, 12);
  const payload = [m, 5, clampInt(param1, 0, 255)];
  if (m === FX_MODE.PAPARAZZI) {
    const p2 = clampInt(param2, 0, 0xffff);
    payload.push((p2 >> 8) & 0xff, p2 & 0xff);
  } else if (!FX_ONE_PARAMETER_MODES.has(m)) {
    payload.push(clampInt(param2, 0, 255));
  }
  return encodeControlFrame(LQ_OPCODE.FX, payload);
}

// Luminosité 0-100, ou interrupteur via les valeurs sentinelles (§9, avertissement).
export function encodeLumLevel(percent) {
  const v = clampInt(percent, 0, 100);
  return encodeControlFrame(LQ_OPCODE.LUM, [(v >> 8) & 0xff, v & 0xff]);
}

export function encodeLumOn() {
  return encodeControlFrame(LQ_OPCODE.LUM, [(LQ_LUM_SENTINEL.ON >> 8) & 0xff, LQ_LUM_SENTINEL.ON & 0xff]);
}

export function encodeLumOff() {
  return encodeControlFrame(LQ_OPCODE.LUM, [(LQ_LUM_SENTINEL.OFF >> 8) & 0xff, LQ_LUM_SENTINEL.OFF & 0xff]);
}

export function encodeCapacityRead() {
  return encodeReadFrame(LQ_OPCODE.CAPACITY);
}

export function encodeVersionRead() {
  return encodeReadFrame(LQ_OPCODE.VERSION);
}

export function encodeStatusRead() {
  return encodeReadFrame(LQ_OPCODE.STATUS);
}

// Les réponses peuvent être préfixées par un marqueur AT (§9.5) : à tronquer avant décodage.
const AT_PREFIXES = ['AT+DATAX@0001=', 'AT+DATA@0001='];

export function stripAtPrefix(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
  for (const prefix of AT_PREFIXES) {
    if (text.startsWith(prefix)) return Buffer.from(text.slice(prefix.length), 'latin1');
  }
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

// LqCStatus (0x43) : réponse [mode][len][xor][v1..v4], vérification XOR obligatoire.
export function decodeStatus(rawBytes) {
  const bytes = stripAtPrefix(rawBytes);
  if (bytes.length < 3) throw new Error('Trame de statut trop courte');
  const [mode, len] = bytes;
  const xor = bytes[2];
  if (bytes.length !== 3 + len) throw new Error('Trame de statut : longueur incohérente');
  const values = bytes.subarray(3, 3 + len);
  if (xorAll(values) !== xor) throw new Error('Trame de statut : XOR invalide');

  const requiredLengths = new Map([[3, 4], [4, 4], [5, 3], [6, 4]]);
  if (requiredLengths.has(mode) && len !== requiredLengths.get(mode)) {
    throw new Error(`Trame de statut : longueur invalide pour le mode ${mode}`);
  }

  switch (mode) {
    case 3: return { type: 'hsi', hue: (values[0] << 8) + values[1], sat: values[2], intensity: values[3] };
    case 4: return { type: 'cct', kelvin: (values[0] << 8) + values[1], intensity: values[2], gm: values[3] - 10 };
    case 5: return { type: 'fx', mode: values[0], freq: values[1], intensity: values[2] };
    case 6: return { type: 'rgbw', r: values[0], g: values[1], b: values[2], w: values[3] };
    case 7: return { type: 'manual_cct', raw: [...values] };
    case 8: return { type: 'manual_hsi', raw: [...values] };
    case 9: return { type: 'pickup', raw: [...values] };
    default: return { type: 'unknown', mode, raw: [...values] };
  }
}

// LqCapacity (0x31) : 8 octets ASCII (chiffres), cf. RM75_SPEC_DEV.md §9.5.
export function decodeCapacity(rawBytes) {
  const bytes = stripAtPrefix(rawBytes);
  if (bytes.length !== 8 || !/^[0-9]{8}$/.test(bytes.toString('ascii'))) {
    throw new Error('Trame de capacité invalide');
  }
  const digit = (i) => bytes[i] - 0x30;
  const battery = digit(0) * 100 + digit(1) * 10 + digit(2);
  const autonomyHours = digit(3) * 10 + digit(4) + digit(5) / 10;
  if (battery > 100 || digit(6) > 2 || digit(7) > 1) throw new Error('Trame de capacité hors plage');
  const chargeState = ['discharged', 'charging', 'full'][digit(6)];
  const poweredOn = bytes[7] === 0x31;
  return { battery, autonomyHours, chargeState, poweredOn };
}

// LqVersion (0x32) : chaîne ASCII découpée sur "_V" -> { type, firmwareVersion }.
export function decodeVersion(rawBytes) {
  const bytes = stripAtPrefix(rawBytes);
  const text = bytes.toString('latin1');
  const sep = text.indexOf('_V');
  if (sep === -1) return { type: text.trim(), firmwareVersion: '' };
  return { type: text.slice(0, sep).trim(), firmwareVersion: text.slice(sep + 2).trim() };
}

// Format confirmé par la chaîne SmallGoGo LqVendorClient -> VendorClient ->
// CoreMeshAdapter : le byte[] opcode `{0x24}` est concaténé littéralement à la trame
// Lq avant l'appel natif. Il n'y a pas de variante E4 5D 00 au niveau Access Payload.
export function buildVendorAccessPayload(lqFrame) {
  return Buffer.concat([Buffer.from([VENDOR_SUBOPCODE_DATA]), lqFrame]);
}
