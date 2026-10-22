"""Encapsulation Proxy PDU + segmentation SAR pour le transport GATT. Pure."""
PROXY_PDU_NETWORK = 0x00
PROXY_PDU_BEACON = 0x01
PROXY_PDU_PROXY_CONFIGURATION = 0x02
PROXY_PDU_PROVISIONING = 0x03

_SAR_COMPLETE, _SAR_FIRST, _SAR_CONTINUATION, _SAR_LAST = 0b00, 0b01, 0b10, 0b11


def encode_proxy_pdus(pdu_type, data, max_attribute_value_length=20):
    """Découpe `data` en fragments Proxy PDU prêts à être écrits sur Data In."""
    data = bytes(data)
    chunk_size = max(1, max_attribute_value_length - 1)
    if len(data) <= chunk_size:
        return [bytes([(_SAR_COMPLETE << 6) | (pdu_type & 0x3F)]) + data]
    chunks = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]
    out = []
    for index, chunk in enumerate(chunks):
        if index == 0:
            sar = _SAR_FIRST
        elif index == len(chunks) - 1:
            sar = _SAR_LAST
        else:
            sar = _SAR_CONTINUATION
        out.append(bytes([(sar << 6) | (pdu_type & 0x3F)]) + chunk)
    return out


class ProxyPduReassembler:
    """Accumulateur de fragments SAR (un seul message en cours à la fois)."""

    def __init__(self):
        self._pending = None  # (type, [chunks])

    def reset(self):
        self._pending = None

    def feed(self, fragment):
        """Renvoie (type, data) quand un message complet est reçu, sinon None."""
        fragment = bytes(fragment)
        if not fragment:
            raise ValueError("Fragment Proxy PDU vide")
        sar, pdu_type, chunk = (fragment[0] >> 6) & 0x03, fragment[0] & 0x3F, fragment[1:]
        if sar == _SAR_COMPLETE:
            self.reset()
            return pdu_type, chunk
        if sar == _SAR_FIRST:
            self._pending = (pdu_type, [chunk])
            return None
        if self._pending is None or self._pending[0] != pdu_type:
            self.reset()
            raise ValueError("Segment Proxy PDU reçu hors séquence (pas de FIRST en cours)")
        self._pending[1].append(chunk)
        if sar == _SAR_CONTINUATION:
            return None
        data = b"".join(self._pending[1])
        self.reset()
        return pdu_type, data
