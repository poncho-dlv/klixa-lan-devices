"""Couches Lower/Upper Transport : chiffrement AppKey/DevKey de l'Access Payload, SEG/AKF/AID, SAR. Pure."""
from .crypto import aes_ccm_decrypt, aes_ccm_encrypt, k4

SEGMENT_PAYLOAD_LENGTH = 12
UNSEGMENTED_MAX_ACCESS_LENGTH = 11  # 15 octets d'upper transport - 4 de TransMIC


def derive_app_key_aid(app_key):
    return k4(bytes(app_key))


def _upper_nonce(key_type, aszmic, seq, src, dst, iv_index):
    return (bytes([0x02 if key_type == "device" else 0x01, (1 if aszmic else 0) << 7])
            + (seq & 0xFFFFFF).to_bytes(3, "big") + src.to_bytes(2, "big") + dst.to_bytes(2, "big")
            + (iv_index & 0xFFFFFFFF).to_bytes(4, "big"))


def encrypt_upper_transport_access(*, key, key_type, seq, src, dst, iv_index, access_payload, aszmic=False):
    mic_length = 8 if aszmic else 4
    ciphertext, mic = aes_ccm_encrypt(key, _upper_nonce(key_type, aszmic, seq, src, dst, iv_index),
                                      access_payload, mic_length)
    return ciphertext + mic


def decrypt_upper_transport_access(*, key, key_type, seq, src, dst, iv_index, enc_access_payload, aszmic=False):
    mic_length = 8 if aszmic else 4
    enc_access_payload = bytes(enc_access_payload)
    if len(enc_access_payload) < mic_length:
        raise ValueError("Upper Transport PDU trop court")
    return aes_ccm_decrypt(key, _upper_nonce(key_type, aszmic, seq, src, dst, iv_index),
                           enc_access_payload[:-mic_length], enc_access_payload[-mic_length:], mic_length)


def encode_lower_transport_unsegmented(*, akf, aid, upper_transport_pdu):
    if len(upper_transport_pdu) > 15:
        raise ValueError("Upper Transport PDU trop long pour du non segmenté (>15 octets)")
    return bytes([((1 if akf else 0) << 6) | (aid & 0x3F)]) + bytes(upper_transport_pdu)


def decode_lower_transport_unsegmented(data):
    data = bytes(data)
    if (data[0] >> 7) & 1:
        raise ValueError("Trame segmentée passée à decode_lower_transport_unsegmented")
    return {"akf": bool((data[0] >> 6) & 1), "aid": data[0] & 0x3F, "upper_transport_pdu": data[1:]}


def segment_upper_transport_pdu(*, akf, aid, seq_zero, szmic, upper_transport_pdu):
    """Découpe l'Upper Transport PDU en segments de 12 octets utiles."""
    pdu = bytes(upper_transport_pdu)
    seg_n = max(0, -(-len(pdu) // SEGMENT_PAYLOAD_LENGTH) - 1)
    segments = []
    for seg_o in range(seg_n + 1):
        chunk = pdu[seg_o * SEGMENT_PAYLOAD_LENGTH:(seg_o + 1) * SEGMENT_PAYLOAD_LENGTH]
        sz = seq_zero & 0x1FFF
        header = bytes([
            0x80 | ((1 if akf else 0) << 6) | (aid & 0x3F),
            ((1 if szmic else 0) << 7) | (sz >> 6),
            ((sz & 0x3F) << 2) | (seg_o >> 3),
            ((seg_o & 0x07) << 5) | (seg_n & 0x1F),
        ])
        segments.append(header + chunk)
    return segments


def decode_segment_header(data):
    data = bytes(data)
    if not (data[0] >> 7) & 1:
        raise ValueError("Trame non segmentée passée à decode_segment_header")
    return {
        "akf": bool((data[0] >> 6) & 1),
        "aid": data[0] & 0x3F,
        "szmic": bool((data[1] >> 7) & 1),
        "seq_zero": ((data[1] & 0x7F) << 6) | (data[2] >> 2),
        "seg_o": ((data[2] & 0x03) << 3) | (data[3] >> 5),
        "seg_n": data[3] & 0x1F,
        "chunk": data[4:],
    }


class MissingSegmentError(Exception):
    pass


def reassemble_segments(headers):
    """Réassemble des segments reçus (dans n'importe quel ordre) en un Upper Transport PDU."""
    if not headers:
        raise ValueError("Aucun segment à réassembler")
    first = headers[0]
    by_seg_o = {}
    for header in headers:
        if header["seg_n"] != first["seg_n"] or header["seq_zero"] != first["seq_zero"]:
            raise ValueError("Segments incohérents (SegN/SeqZero différents)")
        by_seg_o[header["seg_o"]] = header["chunk"]
    for index in range(first["seg_n"] + 1):
        if index not in by_seg_o:
            raise MissingSegmentError(f"Segment manquant : {index}/{first['seg_n']}")
    return {"akf": first["akf"], "aid": first["aid"], "szmic": first["szmic"], "seq_zero": first["seq_zero"],
            "upper_transport_pdu": b"".join(by_seg_o[i] for i in range(first["seg_n"] + 1))}
