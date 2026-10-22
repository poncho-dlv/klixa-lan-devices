"""Couche réseau Bluetooth Mesh : chiffrement AES-CCM + obfuscation d'en-tête. Pure."""
from .crypto import aes_ccm_decrypt, aes_ccm_encrypt, aes_ecb_encrypt, k2, k3


class NetworkPduError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def derive_network_keys(net_key):
    nid, encryption_key, privacy_key = k2(bytes(net_key), b"\x00")
    return {"nid": nid, "encryption_key": encryption_key, "privacy_key": privacy_key,
            "network_id": k3(bytes(net_key))}


def _u16(value):
    return (value & 0xFFFF).to_bytes(2, "big")


def _u24(value):
    return (value & 0xFFFFFF).to_bytes(3, "big")


def _u32(value):
    return (value & 0xFFFFFFFF).to_bytes(4, "big")


def _network_nonce(ctl, ttl, seq, src, iv_index, nonce_type):
    proxy = nonce_type == "proxy"
    pad = 0x00 if proxy else ((1 if ctl else 0) << 7) | (ttl & 0x7F)
    return bytes([0x03 if proxy else 0x00, pad]) + _u24(seq) + _u16(src) + b"\x00\x00" + _u32(iv_index)


def _pecb(privacy_key, iv_index, random7):
    return aes_ecb_encrypt(privacy_key, bytes(5) + _u32(iv_index) + random7)


def encrypt_network_pdu(*, encryption_key, privacy_key, nid, ivi, iv_index, ctl, ttl, seq, src, dst,
                        transport_pdu, nonce_type="network", **_ignored):
    """Encode un Network PDU complet. `ctl` False = message d'accès (MIC 4 octets), True = contrôle (MIC 8)."""
    mic_length = 8 if ctl else 4
    nonce = _network_nonce(ctl, ttl, seq, src, iv_index, nonce_type)
    ciphertext, mic = aes_ccm_encrypt(encryption_key, nonce, _u16(dst) + bytes(transport_pdu), mic_length)
    enc_dst_and_transport = ciphertext + mic
    p = _pecb(privacy_key, iv_index, enc_dst_and_transport[:7])
    header_plain = bytes([((1 if ctl else 0) << 7) | (ttl & 0x7F)]) + _u24(seq) + _u16(src)
    obfuscated = bytes(header_plain[i] ^ p[i] for i in range(6))
    return bytes([((ivi & 1) << 7) | (nid & 0x7F)]) + obfuscated + enc_dst_and_transport


def decrypt_network_pdu(*, encryption_key, privacy_key, nid, iv_index, pdu, nonce_type="network", **_ignored):
    """Décode un Network PDU reçu. Lève si le NID n'est pas le nôtre ou si la MIC est invalide."""
    pdu = bytes(pdu)
    if len(pdu) < 7:
        raise NetworkPduError("Network PDU trop court")
    if (pdu[0] & 0x7F) != nid:
        raise NetworkPduError("NID inconnu (pas notre réseau)", "UNKNOWN_NID")
    ivi = (pdu[0] >> 7) & 1
    if ivi != (iv_index & 1):
        raise NetworkPduError("IVI incompatible avec l'IV Index courant", "IVI_MISMATCH")
    obfuscated, enc_dst_and_transport = pdu[1:7], pdu[7:]
    p = _pecb(privacy_key, iv_index, enc_dst_and_transport[:7])
    header = bytes(obfuscated[i] ^ p[i] for i in range(6))
    ctl = (header[0] >> 7) & 1
    ttl = header[0] & 0x7F
    seq = (header[1] << 16) | (header[2] << 8) | header[3]
    src = (header[4] << 8) | header[5]
    mic_length = 8 if ctl else 4
    if len(enc_dst_and_transport) < 2 + mic_length:
        raise NetworkPduError("Network PDU tronqué")
    ciphertext, mic = enc_dst_and_transport[:-mic_length], enc_dst_and_transport[-mic_length:]
    plaintext = aes_ccm_decrypt(encryption_key, _network_nonce(ctl, ttl, seq, src, iv_index, nonce_type),
                                ciphertext, mic, mic_length)
    return {"ivi": ivi, "ctl": bool(ctl), "ttl": ttl, "seq": seq, "src": src,
            "dst": (plaintext[0] << 8) | plaintext[1], "transport_pdu": plaintext[2:]}
