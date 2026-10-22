"""Couches pures du protocole : vecteurs de la spec (RFC 4493, Mesh Profile) et parité octet pour octet avec
l'implémentation Node.js (tests/node_vectors.json, générés depuis devices/smallrig/src/ble)."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from klixa_smallrig import config_messages as cm  # noqa: E402
from klixa_smallrig import crypto, lq_protocol as lq  # noqa: E402
from klixa_smallrig import network, proxy_pdu, transport  # noqa: E402

V = json.loads((Path(__file__).parent / "node_vectors.json").read_text(encoding="utf-8"))
K = bytes.fromhex("00112233445566778899aabbccddeeff")
A = bytes.fromhex("f0e1d2c3b4a5968778695a4b3c2d1e0f")


class CryptoTests(unittest.TestCase):
    def test_cmac_rfc4493(self):
        key = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
        self.assertEqual(crypto.aes_cmac(key, b"").hex(), "bb1d6929e95937287fa37d129b756746")
        self.assertEqual(crypto.aes_cmac(key, bytes.fromhex("6bc1bee22e409f96e93d7e117393172a")).hex(),
                         "070a16b46b4d4144f79bdd9dd04a287c")

    def test_mesh_spec_sample_s1_k1(self):
        # Mesh Profile 1.0.1, §8.1.1 et §8.1.3
        self.assertEqual(crypto.s1(b"test").hex(), "b73cefbd641ef2ea598c2b6efb62f79c")
        salt = bytes.fromhex("2ba14ffa0df84a2831938d57d276cab4")
        n = bytes.fromhex("3216d1509884b533248541792b877f98")
        p = bytes.fromhex("5a09d60797eeb4478aada59db3352a0d")
        self.assertEqual(crypto.k1(n, salt, p).hex(), "f6ed15a8934afbe7d83e8dcb57fcf5d7")

    def test_mesh_spec_sample_k2_k3_k4(self):
        net_key = bytes.fromhex("7dd7364cd842ad18c17c2b820c84c3d6")
        nid, enc, priv = crypto.k2(net_key, b"\x00")
        self.assertEqual((nid, enc.hex(), priv.hex()), (0x68, "0953fa93e7caac9638f58820220a398e",
                                                       "8b84eedec100067d670971dd2aa700cf"))
        self.assertEqual(crypto.k3(net_key).hex(), "3ecaff672f673370")
        self.assertEqual(crypto.k4(bytes.fromhex("63964771734fbd76e3b40519d1d94a48")), 0x26)

    def test_parity_with_node(self):
        for message, expected in V["cmac"]:
            self.assertEqual(crypto.aes_cmac(K, bytes.fromhex(message)).hex(), expected)
        self.assertEqual(crypto.k1(K, A, b"prck").hex(), V["k1"])
        nid, enc, priv = crypto.k2(K, b"\x00")
        self.assertEqual((nid, enc.hex(), priv.hex()), (V["k2"]["nid"], V["k2"]["enc"], V["k2"]["priv"]))
        self.assertEqual(crypto.k3(K).hex(), V["k3"])
        self.assertEqual(crypto.k4(A), V["k4"])

    def test_ccm_round_trip_and_auth_failure(self):
        nonce = bytes(range(13))
        for mic_length in (4, 8):
            ciphertext, mic = crypto.aes_ccm_encrypt(K, nonce, b"hello world", mic_length)
            self.assertEqual(crypto.aes_ccm_decrypt(K, nonce, ciphertext, mic, mic_length), b"hello world")
            with self.assertRaises(crypto.MeshAuthError):
                crypto.aes_ccm_decrypt(K, nonce, ciphertext, bytes(mic_length), mic_length)

    def test_ecdh_agreement(self):
        priv_a, pub_a = crypto.generate_provisioning_key_pair()
        priv_b, pub_b = crypto.generate_provisioning_key_pair()
        self.assertEqual(len(pub_a), 64)
        self.assertEqual(crypto.compute_shared_secret(priv_a, pub_b), crypto.compute_shared_secret(priv_b, pub_a))


class NetworkLayerTests(unittest.TestCase):
    def setUp(self):
        self.keys = network.derive_network_keys(K)

    def test_derived_keys_match_node(self):
        keys = V["netkeys"]
        self.assertEqual((self.keys["nid"], self.keys["encryption_key"].hex(), self.keys["privacy_key"].hex(),
                          self.keys["network_id"].hex()), (keys["nid"], keys["enc"], keys["priv"], keys["id"]))

    def test_network_pdus_match_node_and_round_trip(self):
        for vector in V["net"]:
            pdu = network.encrypt_network_pdu(
                **self.keys, ivi=0, iv_index=0, ctl=vector["ctl"], ttl=vector["ttl"], seq=vector["seq"],
                src=vector["src"], dst=vector["dst"], transport_pdu=bytes.fromhex(vector["tp"]),
                nonce_type=vector["nonce"])
            self.assertEqual(pdu.hex(), vector["pdu"])
            decoded = network.decrypt_network_pdu(**self.keys, iv_index=0, pdu=pdu, nonce_type=vector["nonce"])
            self.assertEqual((decoded["seq"], decoded["src"], decoded["dst"], decoded["ctl"], decoded["ttl"]),
                             (vector["seq"], vector["src"], vector["dst"], vector["ctl"], vector["ttl"]))
            self.assertEqual(decoded["transport_pdu"].hex(), vector["tp"])

    def test_foreign_network_is_rejected_by_nid(self):
        other = network.derive_network_keys(A)
        pdu = network.encrypt_network_pdu(**other, ivi=0, iv_index=0, ctl=False, ttl=5, seq=1, src=1, dst=2,
                                          transport_pdu=b"\x00\x01")
        with self.assertRaises(network.NetworkPduError) as caught:
            network.decrypt_network_pdu(**self.keys, iv_index=0, pdu=pdu)
        self.assertEqual(caught.exception.code, "UNKNOWN_NID")


class TransportLayerTests(unittest.TestCase):
    def test_upper_transport_matches_node(self):
        for vector in V["upper"]:
            enc = transport.encrypt_upper_transport_access(
                key=bytes.fromhex(vector["key"]), key_type=vector["keyType"], seq=vector["seq"], src=vector["src"],
                dst=vector["dst"], iv_index=0, access_payload=bytes.fromhex(vector["ap"]))
            self.assertEqual(enc.hex(), vector["enc"])
            clear = transport.decrypt_upper_transport_access(
                key=bytes.fromhex(vector["key"]), key_type=vector["keyType"], seq=vector["seq"], src=vector["src"],
                dst=vector["dst"], iv_index=0, enc_access_payload=enc)
            self.assertEqual(clear.hex(), vector["ap"])

    def test_segmentation_matches_node_and_reassembles(self):
        upper = bytes.fromhex("000102030405060708090a0b0c0d0e0f1011121314151617")
        segments = transport.segment_upper_transport_pdu(akf=False, aid=0, seq_zero=0x1ABC, szmic=False,
                                                         upper_transport_pdu=upper)
        self.assertEqual([s.hex() for s in segments], V["segments"])
        headers = [transport.decode_segment_header(s) for s in reversed(segments)]
        result = transport.reassemble_segments(headers)
        self.assertEqual(result["upper_transport_pdu"], upper)
        self.assertEqual(result["seq_zero"], 0x1ABC)

    def test_missing_segment_is_detected(self):
        upper = bytes(30)
        segments = transport.segment_upper_transport_pdu(akf=True, aid=3, seq_zero=5, szmic=False,
                                                         upper_transport_pdu=upper)
        with self.assertRaises(transport.MissingSegmentError):
            transport.reassemble_segments([transport.decode_segment_header(segments[0])])

    def test_unsegmented_encoding_matches_node(self):
        upper = bytes.fromhex("000102030405060708090a0b0c0d0e0f1011121314151617")
        self.assertEqual(transport.encode_lower_transport_unsegmented(akf=True, aid=12, upper_transport_pdu=upper[:8]).hex(),
                         V["unseg"])


class ProxyPduTests(unittest.TestCase):
    def test_fragments_match_node_and_reassemble(self):
        data = bytes([0x5A]) * 45
        fragments = proxy_pdu.encode_proxy_pdus(0, data, 20)
        self.assertEqual([f.hex() for f in fragments], V["proxy"])
        reassembler = proxy_pdu.ProxyPduReassembler()
        results = [reassembler.feed(f) for f in fragments]
        self.assertEqual(results[:-1], [None] * (len(fragments) - 1))
        self.assertEqual(results[-1], (0, data))

    def test_continuation_without_first_is_rejected(self):
        with self.assertRaises(ValueError):
            proxy_pdu.ProxyPduReassembler().feed(bytes([0b10 << 6]) + b"x")


class ConfigAndLqTests(unittest.TestCase):
    def test_config_messages_match_node(self):
        self.assertEqual(cm.encode_composition_data_get(0).hex(), V["cfg"]["compGet"])
        self.assertEqual(cm.encode_app_key_add(K).hex(), V["cfg"]["appKeyAdd"])
        self.assertEqual(cm.encode_model_app_bind(0x0005, 0x100003F6).hex(), V["cfg"]["bind"])

    def test_composition_data_page0(self):
        header = bytes(11)
        element = (0).to_bytes(2, "little") + bytes([1, 1]) + (0x0000).to_bytes(2, "little") \
            + (0x03F6).to_bytes(2, "little") + (0x1000).to_bytes(2, "little")
        parsed = cm.parse_composition_data_page0(header + element)
        self.assertEqual(parsed["elements"][0]["vendor_models"], [0x100003F6])

    def test_status_decoders(self):
        status = cm.decode_model_app_status(bytes([0, 5, 0, 0, 0]) + (0x100003F6).to_bytes(4, "little"))
        self.assertTrue(status["ok"] and status["is_vendor_model"] and status["model_id"] == 0x100003F6)
        self.assertEqual(cm.decode_app_key_status(bytes([0, 0, 0, 0]))["ok"], True)

    def test_lq_frames_match_node(self):
        expected = V["lq"]
        self.assertEqual(lq.encode_hsi(200, 80, 55).hex(), expected["hsi"])
        self.assertEqual(lq.encode_cct(5600, 70, -3).hex(), expected["cct"])
        self.assertEqual(lq.encode_rgbw(1, 2, 3, 4).hex(), expected["rgbw"])
        self.assertEqual(lq.encode_fx(1, 3, 700).hex(), expected["fx1"])
        self.assertEqual(lq.encode_fx(3, 3).hex(), expected["fx3"])
        self.assertEqual(lq.encode_fx(2, 3, 9).hex(), expected["fx2"])
        self.assertEqual(lq.encode_lum_level(42).hex(), expected["lum"])
        self.assertEqual(lq.encode_lum_on().hex(), expected["on"])
        self.assertEqual(lq.encode_lum_off().hex(), expected["off"])
        self.assertEqual(lq.build_vendor_access_payload(lq.encode_lum_on()).hex(), expected["vendor"])

    def test_status_decoding_checks_xor(self):
        frame = lq.encode_control_frame(3, [0, 200, 80, 55])
        self.assertEqual(lq.decode_status(frame), {"type": "hsi", "hue": 200, "sat": 80, "intensity": 55})
        corrupted = frame[:2] + bytes([frame[2] ^ 1]) + frame[3:]
        with self.assertRaises(ValueError):
            lq.decode_status(corrupted)

    def test_capacity_and_version(self):
        capacity = lq.decode_capacity(b"AT+DATA@0001=08500611")
        self.assertEqual(capacity["battery"], 85)
        self.assertEqual(capacity["charge_state"], "charging")
        self.assertTrue(capacity["powered_on"])
        self.assertEqual(lq.decode_version(b"RM75_V1.2.3"), {"type": "RM75", "firmware_version": "1.2.3"})


if __name__ == "__main__":
    unittest.main()
