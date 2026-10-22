"""Firmware RM75 simulé : couvre le provisioning, le mode Proxy, la configuration et les commandes Lq avec de vraies
couches mesh (chiffrement, segmentation, Segment Ack). Remplace le matériel dans les tests de `MeshClient`."""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from klixa_smallrig import config_messages as cfg  # noqa: E402
from klixa_smallrig import lq_protocol as lq  # noqa: E402
from klixa_smallrig import provisioning  # noqa: E402
from klixa_smallrig.ble import LampAdvertisement  # noqa: E402
from klixa_smallrig.mesh_client import VENDOR_MODEL_ID, AsyncQueue  # noqa: E402
from klixa_smallrig.network import decrypt_network_pdu, derive_network_keys, encrypt_network_pdu  # noqa: E402
from klixa_smallrig.proxy_pdu import (PROXY_PDU_NETWORK, PROXY_PDU_PROVISIONING, PROXY_PDU_PROXY_CONFIGURATION,  # noqa: E402
                                      ProxyPduReassembler, encode_proxy_pdus)
from klixa_smallrig.transport import (decode_lower_transport_unsegmented, decode_segment_header,  # noqa: E402
                                      decrypt_upper_transport_access, derive_app_key_aid,
                                      encode_lower_transport_unsegmented, encrypt_upper_transport_access,
                                      reassemble_segments, segment_upper_transport_pdu)

CAPABILITIES = {"num_elements": 1, "algorithms": 1, "public_key_type": 0, "static_oob_type": 0,
                "output_oob_size": 0, "output_oob_action": 0, "input_oob_size": 0, "input_oob_action": 0}


class FakeConnection:
    max_attribute_value_length = 20

    def __init__(self, lamp, mode, on_data):
        self.lamp, self.mode, self.on_data = lamp, mode, on_data
        self.connected = True
        self.reassembler = ProxyPduReassembler()

    async def write(self, fragment):
        if not self.connected:
            raise RuntimeError("Connexion GATT fermée")
        message = self.reassembler.feed(fragment)
        if message:
            self.lamp.receive(self, *message)

    def notify(self, pdu_type, data):
        loop = asyncio.get_running_loop()
        for fragment in encode_proxy_pdus(pdu_type, data, self.max_attribute_value_length):
            loop.call_soon(self.on_data, fragment)

    async def close(self):
        self.connected = False


class FakeLamp:
    """Une lampe RM75 : non provisionnée au départ, puis nœud d'un réseau mesh en mode Proxy."""

    def __init__(self, device_uuid=None, fail_composition=False):
        self.device_uuid = device_uuid or os.urandom(16)
        self.address = "AA:BB:CC:" + self.device_uuid[:3].hex(":")
        self.provisioned = False
        self.net_keys = None
        self.iv_index = 0
        self.unicast = None
        self.device_key = None
        self.app_key = None
        self.app_aid = None
        self.seq = 0x100
        self.received_lq = []  # trames Lq reçues (déchiffrées avec l'AppKey)
        self.proxy_filter = []
        self.reset_count = 0
        self.status_frame = lq.encode_control_frame(3, [0, 200, 80, 55])  # HSI 200°/80/55
        self.capacity = b"08500611"
        self.fail_composition = fail_composition
        self._segments = {}
        self._provisioning_queue = AsyncQueue()
        self._provisioning_task = None

    def adopt(self, state, node):
        """Fait de cette lampe un nœud déjà provisionné et configuré du réseau décrit par `state`."""
        self.net_keys = derive_network_keys(bytes.fromhex(state["netKey"]))
        self.iv_index = state["ivIndex"]
        self.unicast = node["unicastAddress"]
        self.device_key = bytes.fromhex(node["deviceKey"])
        self.app_key = bytes.fromhex(state["appKey"])
        self.app_aid = derive_app_key_aid(self.app_key)
        self.provisioned = True

    # --- annonces ----------------------------------------------------------------------------

    def advertisement(self, network_id=None):
        if self.provisioned:
            return LampAdvertisement(self.address, "provisioned", self, network_id=network_id, rssi=-50, name="RM75")
        return LampAdvertisement(self.address, "unprovisioned", self, device_uuid=self.device_uuid, rssi=-50,
                                 name="RM75")

    # --- entrée des PDU ----------------------------------------------------------------------

    def receive(self, conn, pdu_type, data):
        if conn.mode == "provisioning":
            if pdu_type == PROXY_PDU_PROVISIONING:
                self._provisioning_queue.push(bytes(data))
            return
        if pdu_type == PROXY_PDU_PROXY_CONFIGURATION:
            self._handle_proxy_configuration(conn, data)
        elif pdu_type == PROXY_PDU_NETWORK:
            self._handle_network(conn, data)

    def start_provisioning(self, conn):
        lamp = self

        class DeviceTransport:
            async def send(self, pdu_type, params):
                conn.notify(PROXY_PDU_PROVISIONING, bytes([pdu_type]) + bytes(params))

            async def receive(self, expected_type):
                raw = await lamp._provisioning_queue.shift(5)
                assert raw[0] == expected_type, f"type inattendu {raw[0]} != {expected_type}"
                return raw[1:]

        async def run():
            result = await provisioning.simulate_device_side(transport=DeviceTransport(), capabilities=CAPABILITIES)
            data = result["provisioning_data"]
            self.device_key = result["device_key"]
            self.unicast = data["unicast_address"]
            self.iv_index = data["iv_index"]
            self.net_keys = derive_network_keys(data["net_key"])
            self.provisioned = True

        self._provisioning_task = asyncio.ensure_future(run())

    # --- Proxy configuration -----------------------------------------------------------------

    def _handle_proxy_configuration(self, conn, data):
        decoded = decrypt_network_pdu(**self.net_keys, iv_index=self.iv_index, pdu=data, nonce_type="proxy")
        params = decoded["transport_pdu"]
        if params[0] == 0x00:  # Set Filter Type
            self.proxy_filter = []
            status = bytes([0x03, params[1], 0, 0])
        else:  # Add Addresses
            self.proxy_filter += [int.from_bytes(params[i:i + 2], "big") for i in range(1, len(params), 2)]
            status = bytes([0x03, 0x00]) + len(self.proxy_filter).to_bytes(2, "big")
        reply = encrypt_network_pdu(**self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=True, ttl=0,
                                    seq=self._next_seq(), src=self.unicast, dst=0x0000, transport_pdu=status,
                                    nonce_type="proxy")
        conn.notify(PROXY_PDU_PROXY_CONFIGURATION, reply)

    # --- messages réseau ---------------------------------------------------------------------

    def _next_seq(self):
        self.seq += 1
        return self.seq - 1

    def _handle_network(self, conn, data):
        decoded = decrypt_network_pdu(**self.net_keys, iv_index=self.iv_index, pdu=data)
        if decoded["dst"] != self.unicast or decoded["ctl"]:
            return
        pdu = decoded["transport_pdu"]
        if not (pdu[0] >> 7) & 1:
            lower = decode_lower_transport_unsegmented(pdu)
            self._handle_access(conn, decoded["src"], decoded["seq"], lower["akf"], lower["aid"], False,
                                lower["upper_transport_pdu"])
            return
        header = decode_segment_header(pdu)
        key = (decoded["src"], header["seq_zero"])
        entry = self._segments.setdefault(key, {"segments": {}, "first_seq": decoded["seq"]})
        entry["first_seq"] = min(entry["first_seq"], decoded["seq"])
        entry["segments"][header["seg_o"]] = header
        if len(entry["segments"]) != header["seg_n"] + 1:
            return
        del self._segments[key]
        block_ack = (1 << (header["seg_n"] + 1)) - 1
        ack = bytes([0x00, (header["seq_zero"] >> 6) & 0x7F, (header["seq_zero"] & 0x3F) << 2]) \
            + block_ack.to_bytes(4, "big")
        conn.notify(PROXY_PDU_NETWORK, encrypt_network_pdu(
            **self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=True, ttl=5, seq=self._next_seq(),
            src=self.unicast, dst=decoded["src"], transport_pdu=ack))
        result = reassemble_segments(list(entry["segments"].values()))
        seq_auth = (entry["first_seq"] & ~0x1FFF) | header["seq_zero"]
        self._handle_access(conn, decoded["src"], seq_auth, result["akf"], result["aid"], result["szmic"],
                            result["upper_transport_pdu"])

    def _handle_access(self, conn, src, seq, akf, aid, szmic, upper):
        key = self.app_key if akf else self.device_key
        payload = decrypt_upper_transport_access(key=key, key_type="app" if akf else "device", seq=seq, src=src,
                                                 dst=self.unicast, iv_index=self.iv_index, enc_access_payload=upper,
                                                 aszmic=szmic)
        if akf:
            self._handle_lq(conn, src, payload)
        else:
            self._handle_config(conn, src, payload)

    def _handle_lq(self, conn, src, payload):
        assert payload[0] == lq.VENDOR_SUBOPCODE_DATA
        frame = payload[1:]
        self.received_lq.append(frame)
        if frame == lq.encode_status_read():
            self._reply(conn, src, "app", bytes([lq.VENDOR_SUBOPCODE_DATA]) + self.status_frame)
        elif frame == lq.encode_capacity_read():
            self._reply(conn, src, "app", bytes([lq.VENDOR_SUBOPCODE_DATA]) + self.capacity)

    def _handle_config(self, conn, src, payload):
        decoded = cfg.decode_access_opcode(payload)
        opcode, params = decoded["opcode"], decoded["params"]
        if opcode == cfg.COMPOSITION_DATA_GET:
            if self.fail_composition:
                return
            element = ((0).to_bytes(2, "little") + bytes([2, 1]) + (0x0000).to_bytes(2, "little")
                       + (0x0002).to_bytes(2, "little") + (0x03F6).to_bytes(2, "little")
                       + (0x1000).to_bytes(2, "little"))
            body = bytes([0x00]) + bytes(10) + element
            self._reply(conn, src, "device", cfg.encode_config_opcode(cfg.COMPOSITION_DATA_STATUS) + body)
        elif opcode == cfg.APP_KEY_ADD:
            self.app_key = bytes(params[3:19])
            self.app_aid = derive_app_key_aid(self.app_key)
            self._reply(conn, src, "device", cfg.encode_config_opcode(cfg.APP_KEY_STATUS) + bytes([0, 0, 0, 0]))
        elif opcode == cfg.MODEL_APP_BIND:
            element_address = int.from_bytes(params[0:2], "little")
            status = (cfg.encode_config_opcode(cfg.MODEL_APP_STATUS) + bytes([0]) + params[0:2] + params[2:4]
                      + params[4:8])
            assert element_address == self.unicast
            self._reply(conn, src, "device", status)
        elif opcode == cfg.NODE_RESET:
            self.reset_count += 1
            self._reply(conn, src, "device", cfg.encode_config_opcode(cfg.NODE_RESET_STATUS))
            self.provisioned = False

    def _reply(self, conn, dst, key_type, access_payload):
        key = self.app_key if key_type == "app" else self.device_key
        first_seq = self._next_seq()
        upper = encrypt_upper_transport_access(key=key, key_type=key_type, seq=first_seq, src=self.unicast, dst=dst,
                                               iv_index=self.iv_index, access_payload=access_payload)
        akf, aid = key_type == "app", (self.app_aid if key_type == "app" else 0)
        if len(access_payload) <= 11:
            transport = encode_lower_transport_unsegmented(akf=akf, aid=aid, upper_transport_pdu=upper)
            conn.notify(PROXY_PDU_NETWORK, encrypt_network_pdu(
                **self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=False, ttl=5, seq=first_seq,
                src=self.unicast, dst=dst, transport_pdu=transport))
            return
        segments = segment_upper_transport_pdu(akf=akf, aid=aid, seq_zero=first_seq & 0x1FFF, szmic=False,
                                               upper_transport_pdu=upper)
        for index, segment in enumerate(segments):
            conn.notify(PROXY_PDU_NETWORK, encrypt_network_pdu(
                **self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=False, ttl=5,
                seq=first_seq if index == 0 else self._next_seq(), src=self.unicast, dst=dst,
                transport_pdu=segment))


class FakeBle:
    """Fonctions BLE injectées dans `MeshClient` / `LampController`."""

    def __init__(self, lamps, get_state):
        self.lamps = lamps
        self.get_state = get_state  # pour annoncer le Network ID des lampes provisionnées
        self.proxy_opens = 0

    def _network_id(self):
        state = self.get_state()
        return derive_network_keys(bytes.fromhex(state["netKey"]))["network_id"] if state.get("netKey") else None

    async def scan_for_lamp_advertisements(self, timeout_ms=6000, stop_when=None):
        return [lamp.advertisement(self._network_id()) for lamp in self.lamps]

    async def wait_for_proxy_advertisement(self, timeout_ms=5000, retry_delay_ms=500):
        return [lamp.advertisement(self._network_id()) for lamp in self.lamps if lamp.provisioned]

    async def open_provisioning_connection(self, candidate, on_data):
        lamp = candidate.device
        conn = FakeConnection(lamp, "provisioning", on_data)
        lamp.start_provisioning(conn)
        return conn

    async def open_proxy_connection(self, candidate, on_data):
        self.proxy_opens += 1
        return FakeConnection(candidate.device, "proxy", on_data)
