"""Primitives cryptographiques Bluetooth Mesh Profile 1.0.1 (annexe 8) : AES-CMAC, dérivations
s1/k1/k2/k3/k4, AES-CCM et échange ECDH P-256 du provisioning. Aucune dépendance au matériel Bluetooth."""
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESCCM
from cryptography.hazmat.primitives.cmac import CMAC

ZERO16 = bytes(16)
CCM_NONCE_LENGTH = 13
CCM_MIC_LENGTHS = (4, 8)


class MeshAuthError(Exception):
    """Authentification AES-CCM invalide (MIC incorrecte : rejeu, corruption ou mauvaise clé)."""


def aes_ecb_encrypt(key, block):
    """Un seul bloc AES-128-ECB (obfuscation d'en-tête réseau, PECB)."""
    encryptor = Cipher(algorithms.AES(bytes(key)), modes.ECB()).encryptor()
    return encryptor.update(bytes(block)) + encryptor.finalize()


def aes_cmac(key, message):
    mac = CMAC(algorithms.AES(bytes(key)))
    mac.update(bytes(message))
    return mac.finalize()


def s1(message):
    """s1(M) = AES-CMAC(ZERO, M)."""
    return aes_cmac(ZERO16, message)


def k1(n, salt, p):
    """k1(N, SALT, P) = AES-CMAC(AES-CMAC(SALT, N), P)."""
    return aes_cmac(aes_cmac(salt, n), p)


def k2(n, p):
    """k2(N, P) -> (nid, encryption_key, privacy_key)."""
    salt = s1(b"smk2")
    t = aes_cmac(salt, n)
    t1 = aes_cmac(t, p + b"\x01")
    t2 = aes_cmac(t, t1 + p + b"\x02")
    t3 = aes_cmac(t, t2 + p + b"\x03")
    relevant = (t1 + t2 + t3)[-33:]
    return relevant[0] & 0x7F, relevant[1:17], relevant[17:33]


def k3(n):
    """k3(N) -> Network ID (8 octets)."""
    salt = s1(b"smk3")
    t = aes_cmac(salt, n)
    return aes_cmac(t, b"id64\x01")[-8:]


def k4(n):
    """k4(N) -> AID (6 bits, dérivé de l'AppKey)."""
    salt = s1(b"smk4")
    t = aes_cmac(salt, n)
    return aes_cmac(t, b"id6\x01")[-1] & 0x3F


def _check_ccm(key, nonce, mic_length):
    if len(key) != 16:
        raise ValueError("La clé AES-CCM doit contenir exactement 16 octets")
    if len(nonce) != CCM_NONCE_LENGTH:
        raise ValueError(f"Le nonce AES-CCM Bluetooth Mesh doit contenir exactement {CCM_NONCE_LENGTH} octets")
    if mic_length not in CCM_MIC_LENGTHS:
        raise ValueError("La MIC AES-CCM Bluetooth Mesh doit contenir 4 ou 8 octets")


def aes_ccm_encrypt(key, nonce, plaintext, mic_length=4):
    """Renvoie (ciphertext, mic). Pas d'AAD dans le profil Bluetooth Mesh."""
    key, nonce, plaintext = bytes(key), bytes(nonce), bytes(plaintext)
    _check_ccm(key, nonce, mic_length)
    sealed = AESCCM(key, tag_length=mic_length).encrypt(nonce, plaintext, None)
    return sealed[:-mic_length], sealed[-mic_length:]


def aes_ccm_decrypt(key, nonce, ciphertext, mic, mic_length=4):
    key, nonce, ciphertext, mic = bytes(key), bytes(nonce), bytes(ciphertext), bytes(mic)
    _check_ccm(key, nonce, mic_length)
    if len(mic) != mic_length:
        raise ValueError(f"La MIC AES-CCM doit contenir exactement {mic_length} octets")
    try:
        return AESCCM(key, tag_length=mic_length).decrypt(nonce, ciphertext + mic, None)
    except InvalidTag as error:
        raise MeshAuthError("Authentification AES-CCM invalide (MIC incorrecte)") from error


def generate_provisioning_key_pair():
    """Renvoie (clé privée ECDH, clé publique X||Y sur 64 octets, format du PDU Public Key)."""
    private = ec.generate_private_key(ec.SECP256R1())
    numbers = private.public_key().public_numbers()
    return private, numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")


def compute_shared_secret(private, peer_public_xy):
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b"\x04" + bytes(peer_public_xy))
    return private.exchange(ec.ECDH(), peer)


def random_bytes(length):
    return os.urandom(length)
