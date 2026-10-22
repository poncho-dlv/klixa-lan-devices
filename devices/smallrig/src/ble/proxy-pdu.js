// Encapsulation Proxy PDU + segmentation SAR pour le transport GATT (RM75_SPEC_DEV.md
// §2). Chaque écriture/notification GATT sur les caractéristiques Data In/Data Out
// (0x2ADB/0x2ADC en provisioning, 0x2ADD/0x2ADE en proxy) transporte un fragment de ce
// format. Pure : ne dépend pas de la lib BLE utilisée (cf. ble-transport.js).

export const PROXY_PDU_TYPE = {
  NETWORK: 0x00,
  BEACON: 0x01,
  PROXY_CONFIGURATION: 0x02,
  PROVISIONING: 0x03
};

const SAR = { COMPLETE: 0b00, FIRST: 0b01, CONTINUATION: 0b10, LAST: 0b11 };

// Découpe `data` en un ou plusieurs fragments Proxy PDU prêts à être écrits tels quels
// sur la caractéristique Data In. `maxAttributeValueLength` = taille max d'une valeur
// GATT écrite en une fois (ATT_MTU - 3, déjà calculée par la couche transport) ; on y
// réserve 1 octet pour l'en-tête Proxy PDU.
export function encodeProxyPdus(type, data, { maxAttributeValueLength = 20 } = {}) {
  const chunkSize = Math.max(1, maxAttributeValueLength - 1);
  if (data.length <= chunkSize) {
    return [Buffer.concat([Buffer.from([(SAR.COMPLETE << 6) | (type & 0x3f)]), data])];
  }

  const chunks = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, offset + chunkSize));
  }
  return chunks.map((chunk, i) => {
    let sar;
    if (i === 0) sar = SAR.FIRST;
    else if (i === chunks.length - 1) sar = SAR.LAST;
    else sar = SAR.CONTINUATION;
    return Buffer.concat([Buffer.from([(sar << 6) | (type & 0x3f)]), chunk]);
  });
}

export function decodeProxyPduFragment(bytes) {
  if (bytes.length < 1) throw new Error('Fragment Proxy PDU vide');
  const sar = (bytes[0] >> 6) & 0x03;
  const type = bytes[0] & 0x3f;
  return { sar, type, chunk: bytes.subarray(1) };
}

// Accumulateur de fragments SAR côté réception (notifications sur Data Out). Un seul
// message en cours de réassemblage à la fois, conformément au protocole (les segments
// ne peuvent pas être entrelacés avec un autre message, cf. §2).
export function createProxyPduReassembler() {
  let pending = null; // { type, parts: Buffer[] }

  function reset() {
    pending = null;
  }

  // Retourne { type, data } quand un message complet est reçu, sinon null.
  function feed(fragmentBytes) {
    const { sar, type, chunk } = decodeProxyPduFragment(fragmentBytes);

    if (sar === SAR.COMPLETE) {
      reset();
      return { type, data: chunk };
    }

    if (sar === SAR.FIRST) {
      pending = { type, parts: [chunk] };
      return null;
    }

    if (!pending || pending.type !== type) {
      reset();
      throw new Error('Segment Proxy PDU reçu hors séquence (pas de FIRST en cours)');
    }

    pending.parts.push(chunk);
    if (sar === SAR.CONTINUATION) return null;

    // SAR.LAST
    const data = Buffer.concat(pending.parts);
    reset();
    return { type, data };
  }

  return { feed, reset };
}
