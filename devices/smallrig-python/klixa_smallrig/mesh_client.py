"""Orchestrateur mesh : combine crypto, couche réseau, transport, Proxy PDU, provisioning et protocole Lq par-dessus
le transport BLE (ble.py) — scan, provisioning, configuration, envoi de commandes, lecture d'état.

Les fonctions BLE sont injectées (voir `MeshClient.__init__`) : un firmware simulé couvre le parcours complet
dans les tests, la validation radio reste à faire sur une lampe physique."""
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from . import config_messages as cfg
from . import lq_protocol as lq
from .network import NetworkPduError, decrypt_network_pdu, derive_network_keys, encrypt_network_pdu
from .provisioning import run_provisioning
from .proxy_pdu import (PROXY_PDU_NETWORK, PROXY_PDU_PROVISIONING, PROXY_PDU_PROXY_CONFIGURATION,
                        ProxyPduReassembler, encode_proxy_pdus)
from .store import (add_node, allocate_unicast_address, app_key_bytes, clear_pending_provisioning, ensure_network_keys,
                    find_node, net_key_bytes, next_seq, node_device_key_bytes, remove_node, set_pending_provisioning)
from .transport import (UNSEGMENTED_MAX_ACCESS_LENGTH, decode_lower_transport_unsegmented, decode_segment_header,
                        decrypt_upper_transport_access, derive_app_key_aid, encode_lower_transport_unsegmented,
                        encrypt_upper_transport_access, reassemble_segments, segment_upper_transport_pdu)

log = logging.getLogger("smallrig.mesh")

# MESH_MODEL_DATATRANS_SERVER : ModelID 0x1000, CID 0x03F6 (corrigé depuis la Composition Data réelle d'une RM75).
VENDOR_MODEL_ID = 0x100003F6
DEFAULT_TTL = 5
CONFIG_RESPONSE_TIMEOUT_S = 8.0
COMMAND_RESPONSE_TIMEOUT_S = 5.0
SEGMENT_ACK_TIMEOUT_S = 1.2
SEGMENT_SEND_ATTEMPTS = 3
PROXY_FILTER_TIMEOUT_S = 3.0
REPLAY_WINDOW = 8192
PROXY_FILTER_TYPE_ACCEPTLIST = 0x00
PROXY_CONFIG_SET_FILTER_TYPE, PROXY_CONFIG_ADD_ADDRESSES, PROXY_CONFIG_FILTER_STATUS = 0x00, 0x01, 0x03


class MeshError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class MeshTimeout(MeshError):
    pass


class AsyncQueue:
    def __init__(self):
        self._queue = asyncio.Queue()

    def push(self, value):
        self._queue.put_nowait(value)

    async def shift(self, timeout_s=None):
        try:
            if timeout_s:
                return await asyncio.wait_for(self._queue.get(), timeout_s)
            return await self._queue.get()
        except asyncio.TimeoutError as error:
            raise MeshTimeout("Délai dépassé en attente de réponse") from error

    def clear(self):
        while not self._queue.empty():
            self._queue.get_nowait()


@dataclass
class SeqAllocator:
    state: dict
    block_size: int
    on_persist_needed: Optional[Callable[[], Awaitable[None]]] = None


class _SegmentTracker:
    def __init__(self, full_mask):
        self.block_ack = 0
        self.full_mask = full_mask
        self.received_ack = False
        self.event = asyncio.Event()


class ProxySession:
    """Une session Proxy GATT ouverte vers N'IMPORTE QUEL nœud du mesh atteint TOUS les nœuds (relayage mesh
    standard) : une seule connexion active à la fois, réutilisée pour toutes les commandes."""

    def __init__(self, conn, net_keys, iv_index, provisioner_address, seq_allocator_factory):
        self.conn = conn
        self.net_keys = net_keys
        self.iv_index = iv_index
        self.provisioner_address = provisioner_address
        self.seq_allocator_factory = seq_allocator_factory
        self._reassembler = ProxyPduReassembler()
        self._segment_buffers = {}
        self._completed_segmented = {}
        self._pending_segment_acks = {}
        self._replay = {}
        self._inbox = {}
        self._proxy_config_inbox = AsyncQueue()
        # Un seul verrou couvre allocation SEQ -> persistance du high-water -> chiffrement -> tous les
        # fragments : aucun await de persistance ne peut inverser deux numéros de séquence concurrents.
        self._send_lock = asyncio.Lock()
        self._persistence_failure = None
        self._background = set()

    # --- état ---------------------------------------------------------------------------------

    @property
    def connected(self):
        return not self._persistence_failure and self.conn.connected

    async def close(self):
        await self.conn.close()

    def _inbox_for(self, src):
        if src not in self._inbox:
            self._inbox[src] = AsyncQueue()
        return self._inbox[src]

    def clear_inbox(self, src):
        self._inbox_for(src).clear()

    async def receive_from(self, src, timeout_s=COMMAND_RESPONSE_TIMEOUT_S):
        message = await self._inbox_for(src).shift(timeout_s)
        return {"seq": message["seq"], "upper_transport_pdu": message["upper_transport_pdu"],
                "szmic": bool(message["szmic"]), "key_type": "app" if message["akf"] else "device",
                "aid": message["aid"]}

    # --- envoi --------------------------------------------------------------------------------

    async def _allocate_sequence(self, allocator):
        if self._persistence_failure:
            raise self._persistence_failure
        state = allocator.state
        previous_seq, previous_high_water = state["seq"], state["seqAllocatedUpTo"]
        seq, crossed = next_seq(state, allocator.block_size)
        if crossed and allocator.on_persist_needed:
            try:
                await allocator.on_persist_needed()
            except Exception as error:
                # La file est exclusive : restaurer est sûr, puis on condamne cette session pour qu'aucun envoi
                # suivant n'utilise une réservation non durable.
                state["seq"], state["seqAllocatedUpTo"] = previous_seq, previous_high_water
                self._persistence_failure = error
                raise
        return seq

    async def _write_proxy_pdu(self, pdu_type, data):
        log.debug("→ Proxy PDU type %d, %d octets", pdu_type, len(data))
        for fragment in encode_proxy_pdus(pdu_type, data, self.conn.max_attribute_value_length):
            await self.conn.write(fragment)

    async def send(self, *, src, dst, key, key_type, aid, access_payload, ttl=DEFAULT_TTL):
        async with self._send_lock:
            allocator = self.seq_allocator_factory()
            first_seq = await self._allocate_sequence(allocator)
            upper = encrypt_upper_transport_access(key=key, key_type=key_type, seq=first_seq, src=src, dst=dst,
                                                   iv_index=self.iv_index, access_payload=access_payload)
            akf = key_type == "app"
            ivi = self.iv_index & 1

            if len(access_payload) <= UNSEGMENTED_MAX_ACCESS_LENGTH:
                transport_pdu = encode_lower_transport_unsegmented(akf=akf, aid=aid, upper_transport_pdu=upper)
                pdu = encrypt_network_pdu(**self.net_keys, ivi=ivi, iv_index=self.iv_index, ctl=False, ttl=ttl,
                                          seq=first_seq, src=src, dst=dst, transport_pdu=transport_pdu)
                await self._write_proxy_pdu(PROXY_PDU_NETWORK, pdu)
                return

            seq_zero = first_seq & 0x1FFF
            segments = segment_upper_transport_pdu(akf=akf, aid=aid, seq_zero=seq_zero, szmic=False,
                                                   upper_transport_pdu=upper)
            full_mask = 0xFFFFFFFF if len(segments) >= 32 else (1 << len(segments)) - 1
            tracker = _SegmentTracker(full_mask)
            tracker_key = (dst, seq_zero)
            self._pending_segment_acks[tracker_key] = tracker
            try:
                for attempt in range(1, SEGMENT_SEND_ATTEMPTS + 1):
                    for index, segment in enumerate(segments):
                        if tracker.block_ack & (1 << index):
                            continue
                        seq = first_seq if attempt == 1 and index == 0 else await self._allocate_sequence(allocator)
                        pdu = encrypt_network_pdu(**self.net_keys, ivi=ivi, iv_index=self.iv_index, ctl=False,
                                                  ttl=ttl, seq=seq, src=src, dst=dst, transport_pdu=segment)
                        await self._write_proxy_pdu(PROXY_PDU_NETWORK, pdu)
                    if (tracker.block_ack & full_mask) == full_mask:
                        return
                    try:
                        await self._wait_for_segment_ack(tracker, SEGMENT_ACK_TIMEOUT_S)
                    except MeshTimeout:
                        if attempt == SEGMENT_SEND_ATTEMPTS:
                            raise MeshError(f"Message mesh segmenté non acquitté après {SEGMENT_SEND_ATTEMPTS} essais")
                    if tracker.received_ack and tracker.block_ack == 0:
                        raise MeshError("Message mesh segmenté annulé par le nœud")
                    if (tracker.block_ack & full_mask) == full_mask:
                        return
            finally:
                self._pending_segment_acks.pop(tracker_key, None)

    @staticmethod
    async def _wait_for_segment_ack(tracker, timeout_s):
        if (tracker.block_ack & tracker.full_mask) == tracker.full_mask:
            return
        try:
            await asyncio.wait_for(tracker.event.wait(), timeout_s)
        except asyncio.TimeoutError as error:
            raise MeshTimeout("Segment Ack non reçu") from error
        tracker.event.clear()

    async def _send_proxy_configuration(self, transport_pdu, allocator):
        seq = await self._allocate_sequence(allocator)
        pdu = encrypt_network_pdu(**self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=True, ttl=0,
                                  seq=seq, src=self.provisioner_address, dst=0x0000, transport_pdu=transport_pdu,
                                  nonce_type="proxy")
        await self._write_proxy_pdu(PROXY_PDU_PROXY_CONFIGURATION, pdu)
        status = await self._proxy_config_inbox.shift(PROXY_FILTER_TIMEOUT_S)
        if len(status) < 4 or status[0] != PROXY_CONFIG_FILTER_STATUS:
            raise MeshError("Proxy Filter Status invalide ou inattendu")
        return {"filter_type": status[1], "list_size": int.from_bytes(status[2:4], "big")}

    async def configure_proxy_filter(self, addresses=None):
        addresses = [self.provisioner_address] if addresses is None else addresses
        async with self._send_lock:
            self._proxy_config_inbox.clear()
            allocator = self.seq_allocator_factory()
            status = await self._send_proxy_configuration(
                bytes([PROXY_CONFIG_SET_FILTER_TYPE, PROXY_FILTER_TYPE_ACCEPTLIST]), allocator)
            if status["filter_type"] != PROXY_FILTER_TYPE_ACCEPTLIST:
                raise MeshError("Le Proxy a refusé le filtre acceptlist")
            unique = sorted({a for a in addresses if isinstance(a, int) and 0 < a <= 0x7FFF})
            if unique:
                params = bytes([PROXY_CONFIG_ADD_ADDRESSES]) + b"".join(a.to_bytes(2, "big") for a in unique)
                status = await self._send_proxy_configuration(params, allocator)
                if status["filter_type"] != PROXY_FILTER_TYPE_ACCEPTLIST or status["list_size"] != len(unique):
                    raise MeshError("Le Proxy n'a pas appliqué la liste d'adresses demandée")
            return status

    # --- réception ----------------------------------------------------------------------------

    def feed(self, data):
        """Appelé par les notifications GATT (Data Out)."""
        try:
            message = self._reassembler.feed(data)
            if not message:
                return
            pdu_type, payload = message
            log.debug("← Proxy PDU type %d, %d octets", pdu_type, len(payload))
            if pdu_type == PROXY_PDU_NETWORK:
                self._handle_network_pdu(payload)
            elif pdu_type == PROXY_PDU_PROXY_CONFIGURATION:
                self._handle_proxy_configuration_pdu(payload)
        except Exception as error:  # noqa: BLE001
            log.warning("Proxy PDU ignoré : %s", error)

    def _accept_network_sequence(self, src, seq):
        replay = self._replay.setdefault(src, {"highest": -1, "seen": set()})
        if seq in replay["seen"] or seq < replay["highest"] - REPLAY_WINDOW:
            return False
        replay["seen"].add(seq)
        replay["highest"] = max(replay["highest"], seq)
        if len(replay["seen"]) > 256:
            floor = replay["highest"] - REPLAY_WINDOW
            replay["seen"] = {value for value in replay["seen"] if value >= floor}
        return True

    @staticmethod
    def _seq_auth_from(seq, seq_zero):
        auth = (seq & ~0x1FFF) | seq_zero
        if auth > seq:
            auth -= 0x2000
        return auth

    def _remember_completed(self, key, seg_n):
        now = time.monotonic()
        for old_key in [k for k, v in self._completed_segmented.items() if now - v[1] > 30]:
            del self._completed_segmented[old_key]
        self._completed_segmented[key] = (seg_n, now)
        if len(self._completed_segmented) > 32:
            del self._completed_segmented[next(iter(self._completed_segmented))]

    @staticmethod
    def _build_segment_ack(seq_zero, seg_n):
        block_ack = 0xFFFFFFFF if seg_n >= 31 else (1 << (seg_n + 1)) - 1
        return bytes([0x00, (seq_zero >> 6) & 0x7F, (seq_zero & 0x3F) << 2]) + block_ack.to_bytes(4, "big")

    def _notify_segment_ack(self, decoded):
        data = decoded["transport_pdu"]
        if len(data) < 7 or (data[0] & 0x7F) != 0x00:
            return
        seq_zero = ((data[1] & 0x7F) << 6) | (data[2] >> 2)
        tracker = self._pending_segment_acks.get((decoded["src"], seq_zero))
        if not tracker:
            return
        tracker.received_ack = True
        tracker.block_ack |= int.from_bytes(data[3:7], "big")
        tracker.event.set()

    def _spawn(self, coroutine):
        task = asyncio.ensure_future(coroutine)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _send_segment_ack(self, dst, seq_zero, seg_n):
        if not self.seq_allocator_factory:
            return
        try:
            async with self._send_lock:
                allocator = self.seq_allocator_factory()
                seq = await self._allocate_sequence(allocator)
                pdu = encrypt_network_pdu(**self.net_keys, ivi=self.iv_index & 1, iv_index=self.iv_index, ctl=True,
                                          ttl=DEFAULT_TTL, seq=seq, src=self.provisioner_address, dst=dst,
                                          transport_pdu=self._build_segment_ack(seq_zero, seg_n))
                await self._write_proxy_pdu(PROXY_PDU_NETWORK, pdu)
        except Exception as error:  # noqa: BLE001
            log.warning("Envoi du Segment Ack échoué (non bloquant) : %s", error)

    def _handle_network_pdu(self, pdu):
        try:
            decoded = decrypt_network_pdu(**self.net_keys, iv_index=self.iv_index, pdu=pdu)
        except NetworkPduError as error:
            if error.code != "UNKNOWN_NID":
                log.warning("Network PDU ignoré (déchiffrement) : %s", error)
            return
        except Exception as error:  # noqa: BLE001
            log.warning("Network PDU ignoré (déchiffrement) : %s", error)
            return
        log.debug("← Network PDU src=0x%04x dst=0x%04x seq=%d ctl=%s ttl=%d", decoded["src"], decoded["dst"],
                  decoded["seq"], decoded["ctl"], decoded["ttl"])
        if decoded["dst"] != self.provisioner_address:
            return
        if decoded["ctl"]:
            if self._accept_network_sequence(decoded["src"], decoded["seq"]):
                self._notify_segment_ack(decoded)
            return

        transport_pdu = decoded["transport_pdu"]
        if not (transport_pdu[0] >> 7) & 1:
            if not self._accept_network_sequence(decoded["src"], decoded["seq"]):
                return
            lower = decode_lower_transport_unsegmented(transport_pdu)
            self._inbox_for(decoded["src"]).push({"seq": decoded["seq"], "akf": lower["akf"], "aid": lower["aid"],
                                                  "szmic": False, "upper_transport_pdu": lower["upper_transport_pdu"]})
            return

        header = decode_segment_header(transport_pdu)
        key = (decoded["src"], header["seq_zero"])
        completed = self._completed_segmented.get(key)
        if completed and time.monotonic() - completed[1] <= 30:
            # Ré-acquitter même une retransmission : elle ne sera jamais remise dans l'inbox, mais indique que
            # notre ACK précédent s'est perdu.
            self._spawn(self._send_segment_ack(decoded["src"], header["seq_zero"], completed[0]))
            return
        if not self._accept_network_sequence(decoded["src"], decoded["seq"]):
            return

        buffer = self._segment_buffers.get(key)
        if buffer is None:
            now = time.monotonic()
            for stale_key in [k for k, v in self._segment_buffers.items() if now - v["created_at"] > 15]:
                del self._segment_buffers[stale_key]
            buffer = {"segments": {}, "seq_auth": self._seq_auth_from(decoded["seq"], header["seq_zero"]),
                      "created_at": now}
            self._segment_buffers[key] = buffer
        buffer["segments"][header["seg_o"]] = header
        if len(buffer["segments"]) != header["seg_n"] + 1:
            return
        try:
            result = reassemble_segments(list(buffer["segments"].values()))
            del self._segment_buffers[key]
            self._remember_completed(key, header["seg_n"])
            self._spawn(self._send_segment_ack(decoded["src"], header["seq_zero"], header["seg_n"]))
            self._inbox_for(decoded["src"]).push({"seq": buffer["seq_auth"], "akf": result["akf"],
                                                  "aid": result["aid"], "szmic": result["szmic"],
                                                  "upper_transport_pdu": result["upper_transport_pdu"]})
        except Exception as error:  # noqa: BLE001
            self._segment_buffers.pop(key, None)
            log.warning("Réassemblage de segments échoué : %s", error)

    def _handle_proxy_configuration_pdu(self, pdu):
        try:
            decoded = decrypt_network_pdu(**self.net_keys, iv_index=self.iv_index, pdu=pdu, nonce_type="proxy")
            if (not decoded["ctl"] or decoded["ttl"] != 0 or decoded["dst"] != 0x0000
                    or not self._accept_network_sequence(decoded["src"], decoded["seq"])):
                return
            self._proxy_config_inbox.push(decoded["transport_pdu"])
        except NetworkPduError as error:
            if error.code != "UNKNOWN_NID":
                log.warning("Proxy Configuration PDU ignoré : %s", error)
        except Exception as error:  # noqa: BLE001
            log.warning("Proxy Configuration PDU ignoré : %s", error)


class MeshClient:
    def __init__(self, *, get_state, persist_state, scan_for_lamp_advertisements, open_provisioning_connection,
                 open_proxy_connection, wait_for_proxy_advertisement, scan_for_display=None,
                 run_provisioning_fn=run_provisioning, seq_block_size=100, provisioner_address=None,
                 configure_settle_s=4.0, configure_retry_delay_s=2.0):
        self._get_state = get_state
        self._persist_state = persist_state
        self._scan = scan_for_lamp_advertisements
        self._scan_for_display = scan_for_display or scan_for_lamp_advertisements
        self._open_provisioning = open_provisioning_connection
        self._open_proxy = open_proxy_connection
        self._wait_for_proxy = wait_for_proxy_advertisement
        self._run_provisioning = run_provisioning_fn
        self._seq_block_size = seq_block_size
        self._forced_provisioner_address = provisioner_address
        self._configure_settle_s = configure_settle_s
        self._configure_retry_delay_s = configure_retry_delay_s
        self._proxy_session: Optional[ProxySession] = None
        self._proxy_conn = None
        self._proxy_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._node_locks = {}
        # Dernier candidat Proxy avec lequel une session a réussi : permet une reconnexion DIRECTE après une
        # coupure sans re-payer le pré-scan. Jamais persisté.
        self._last_good_proxy_candidate = None

    # --- utilitaires --------------------------------------------------------------------------

    def _seq_allocator(self):
        state = self._get_state()
        persist = (lambda: self._persist_state(state)) if self._persist_state else None
        return SeqAllocator(state, self._seq_block_size, persist)

    def _net_keys(self, state):
        return derive_network_keys(net_key_bytes(state))

    def _provisioner_address(self, state):
        return self._forced_provisioner_address if self._forced_provisioner_address is not None \
            else state["provisionerAddress"]

    def _node_lock(self, address):
        return self._node_locks.setdefault(address, asyncio.Lock())

    async def _receive_access_matching(self, session, *, source, destination, key, expected_key_type, timeout_s,
                                       match, expected_aid=None):
        deadline = time.monotonic() + timeout_s
        last_mismatch = None
        while time.monotonic() < deadline:
            remaining = max(0.001, deadline - time.monotonic())
            message = await session.receive_from(source, remaining)
            if message["key_type"] != expected_key_type:
                last_mismatch = f"type de clé {message['key_type']}"
                continue
            if expected_key_type == "app" and message["aid"] != expected_aid:
                last_mismatch = f"AID {message['aid']}"
                continue
            try:
                access_payload = decrypt_upper_transport_access(
                    key=key, key_type=message["key_type"], aszmic=message["szmic"], seq=message["seq"], src=source,
                    dst=destination, iv_index=self._get_state()["ivIndex"],
                    enc_access_payload=message["upper_transport_pdu"])
                matched = match(access_payload)
                if matched is not None and matched is not False:
                    return matched
                last_mismatch = "opcode ou format de réponse inattendu"
            except Exception as error:  # noqa: BLE001
                last_mismatch = str(error)
        suffix = f" ({last_mismatch})" if last_mismatch else ""
        raise MeshTimeout(f"Délai dépassé en attente de la réponse attendue{suffix}")

    async def _exchange_config_message(self, session, node, access_payload, expected_opcode, allocator=None):
        state = self._get_state()
        src = self._provisioner_address(state)
        dst = node["unicastAddress"]
        dev_key = node_device_key_bytes(node)
        session.clear_inbox(dst)
        await session.send(src=src, dst=dst, key=dev_key, key_type="device", aid=0, access_payload=access_payload)

        def match(decrypted):
            decoded = cfg.decode_access_opcode(decrypted)
            return decoded if decoded["opcode"] == expected_opcode else None

        return await self._receive_access_matching(session, source=dst, destination=src, key=dev_key,
                                                   expected_key_type="device", timeout_s=CONFIG_RESPONSE_TIMEOUT_S,
                                                   match=match)

    async def _close_proxy(self):
        if self._proxy_conn is not None:
            try:
                await self._proxy_conn.close()
            except Exception:  # noqa: BLE001 - déjà fermé
                pass
        self._proxy_conn = None
        self._proxy_session = None

    # --- session Proxy -----------------------------------------------------------------------

    async def _ensure_proxy_session(self):
        if self._proxy_session and self._proxy_session.connected:
            return self._proxy_session
        # Verrou : deux commandes simultanées ne doivent pas ouvrir deux connexions GATT vers la même lampe
        # (un périphérique BLE n'accepte qu'un central à la fois).
        async with self._proxy_lock:
            if self._proxy_session and self._proxy_session.connected:
                return self._proxy_session
            return await self._establish_proxy_session()

    async def _connect_proxy_candidate(self, candidate):
        state = self._get_state()
        net_keys = self._net_keys(state)
        holder = {"session": None}

        def on_data(data):
            if holder["session"] is not None:
                holder["session"].feed(data)

        conn = await self._open_proxy(candidate, on_data)
        try:
            provisioner = self._provisioner_address(state)
            session = ProxySession(conn, net_keys, state["ivIndex"], provisioner, self._seq_allocator)
            holder["session"] = session
            await session.configure_proxy_filter([provisioner])
            self._proxy_conn = conn
            self._proxy_session = session
            self._last_good_proxy_candidate = candidate
            return session
        except Exception:
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass
            raise

    async def _establish_proxy_session(self):
        state = self._get_state()
        await self._close_proxy()
        if not state["nodes"]:
            raise MeshError("Aucune lampe provisionnée")
        net_keys = self._net_keys(state)

        if self._last_good_proxy_candidate is not None:
            candidate = self._last_good_proxy_candidate
            try:
                return await self._connect_proxy_candidate(candidate)
            except Exception as error:  # noqa: BLE001
                self._last_good_proxy_candidate = None
                log.warning("Reconnexion directe au dernier Proxy connu échouée, re-scan complet : %s", error)

        # Le scan s'arrête dès qu'une lampe de NOTRE réseau est vue (la fenêtre de 8 s n'est qu'un plafond).
        expected = net_keys["network_id"]
        candidates = await self._scan(
            timeout_ms=8000,
            stop_when=lambda lamp: lamp.kind == "provisioned" and bool(lamp.network_id)
            and bytes(lamp.network_id) == expected)
        # Une annonce Network ID authentifie le réseau avant l'ouverture GATT ; les annonces Node Identity ne
        # sont essayées qu'après tous les candidats dont le Network ID correspond exactement.
        exact = [c for c in candidates if c.kind == "provisioned" and c.network_id and bytes(c.network_id) == expected]
        identity = [c for c in candidates if c.kind == "provisioned" and not c.network_id]
        proxy_candidates = exact + identity
        if not proxy_candidates:
            raise MeshError("Aucune lampe SmallRig joignable en Bluetooth à proximité")

        last_error = None
        for candidate in proxy_candidates:
            try:
                return await self._connect_proxy_candidate(candidate)
            except Exception as error:  # noqa: BLE001
                last_error = error
                log.warning("Connexion Proxy échouée sur un candidat, essai suivant : %s", error)
        raise last_error or MeshError("Connexion Proxy impossible")

    # --- découverte --------------------------------------------------------------------------

    async def _discover(self, timeout_ms=6000):
        state = self._get_state()
        our_network_id = self._net_keys(state)["network_id"] if state["netKey"] else None
        paired = {node["uuid"] for node in state["nodes"]}
        found = await self._scan_for_display(timeout_ms=timeout_ms)
        lamps = []
        for lamp in found:
            if lamp.kind == "unprovisioned":
                device_uuid = lamp.device_uuid.hex() if lamp.device_uuid else None
                # Une lampe déjà appairée localement ne doit jamais réapparaître comme « nouvelle ».
                if device_uuid and device_uuid.lower() in paired:
                    continue
                lamps.append({"ble_device_id": lamp.ble_device_id, "kind": "unprovisioned",
                              "device_uuid": device_uuid, "rssi": lamp.rssi, "name": lamp.name, "candidate": lamp})
            else:
                ours = bool(our_network_id and lamp.network_id and bytes(lamp.network_id) == our_network_id)
                lamps.append({"ble_device_id": lamp.ble_device_id, "kind": "provisioned", "ours": ours,
                              "rssi": lamp.rssi, "name": lamp.name, "candidate": lamp})
        return lamps

    # --- provisioning ------------------------------------------------------------------------

    async def _provision(self, ble_device_id=None, device_uuid=None, name=None, attention_duration_s=0):
        state = self._get_state()
        if not self._persist_state:
            raise MeshError("Persistance durable requise avant provisioning mesh")
        ensure_network_keys(state)
        await self._persist_state(state)
        await self._close_proxy()  # libère l'adaptateur pour le scan et la connexion de provisioning

        reassembler = ProxyPduReassembler()
        pending = AsyncQueue()

        def on_data(data):
            message = reassembler.feed(data)
            if message and message[0] == PROXY_PDU_PROVISIONING:
                pending.push(message[1])

        attempts = 3
        conn = None
        target = None
        target_uuid = None
        stale_reconciled = False
        seen_as_provisioned = False
        last_connect_error = None
        for attempt in range(1, attempts + 1):
            if conn:
                break
            found = await self._scan(timeout_ms=8000)
            target = next((f for f in found if f.kind == "unprovisioned" and (
                f.ble_device_id == ble_device_id
                or (device_uuid and f.device_uuid and f.device_uuid.hex().lower() == device_uuid.lower()))), None)
            if target is None:
                seen_as_provisioned = any(f.ble_device_id == ble_device_id and f.kind == "provisioned" for f in found)
                log.warning("Scan d'appairage : lampe cible non trouvée (essai %d/%d), vues : %s", attempt, attempts,
                            [(f.ble_device_id, f.kind, f.rssi) for f in found])
                if seen_as_provisioned:
                    break  # état stable : inutile de rescanner, le message d'erreur guide vers le reset
                if attempt < attempts:
                    await asyncio.sleep(1)
                continue

            target_uuid = target.device_uuid.hex().lower() if target.device_uuid else None
            if not target_uuid or len(target_uuid) != 32:
                raise MeshError("Annonce de provisioning SmallRig invalide : Device UUID Mesh absent ou mal formé")
            # Un beacon 0x1827 portant ce Device UUID prouve que la lampe est actuellement non provisionnée : un
            # nœud/journal local du même UUID vient d'une tentative interrompue ou d'un reset usine.
            if not stale_reconciled:
                removed = remove_node(state, target_uuid)
                cleared = bool(state.get("pendingProvisioning")
                               and state["pendingProvisioning"].get("uuid") == target_uuid)
                clear_pending_provisioning(state, target_uuid)
                if removed or cleared:
                    await self._persist_state(state)
                    log.info("État local obsolète réconcilié avec le beacon non provisionné (%s)", target_uuid)
                stale_reconciled = True
            try:
                conn = await self._open_provisioning(target, on_data)
            except Exception as error:  # noqa: BLE001
                last_connect_error = error
                log.warning("Connexion GATT de provisioning échouée (essai %d/%d) : %s", attempt, attempts, error)
                if attempt < attempts:
                    await asyncio.sleep(1)

        if not conn:
            if seen_as_provisioned:
                raise MeshError("Cette lampe est déjà provisionnée (par ce script, l'app SmallGoGo ou un autre "
                                "appareil). Réinitialise son réseau mesh (reset usine) puis relance un scan.")
            if last_connect_error:
                raise MeshError(f"Connexion à la lampe impossible après {attempts} essais : {last_connect_error}. "
                                "Rapproche la lampe de l'adaptateur et réessaie.")
            raise MeshError("Lampe introuvable malgré plusieurs scans (hors de portée, éteinte, ou adaptateur "
                            "Bluetooth capricieux — réessaie)")

        class _Transport:
            async def send(self_, pdu_type, params):  # noqa: N805
                data = bytes([pdu_type]) + bytes(params)
                for fragment in encode_proxy_pdus(PROXY_PDU_PROVISIONING, data, conn.max_attribute_value_length):
                    await conn.write(fragment)

            async def receive(self_, expected_type):  # noqa: N805
                raw = await pending.shift(CONFIG_RESPONSE_TIMEOUT_S)
                if raw[0] != expected_type:
                    raise MeshError(f"Provisioning : type inattendu (attendu {expected_type}, reçu {raw[0]})")
                return raw[1:]

        provisioning_journaled = False
        pending_before = dict(state["pendingProvisioning"]) if state.get("pendingProvisioning") else None
        next_unicast_before = state["nextUnicastAddress"]

        async def on_before_data(result):
            nonlocal provisioning_journaled
            set_pending_provisioning(state, {
                "uuid": target_uuid, "bleDeviceId": ble_device_id, "name": name,
                "unicastAddress": result["unicast_address"], "elementCount": result["num_elements"],
                "deviceKey": result["device_key"].hex(), "vendorElementAddress": result["unicast_address"],
                "phase": "data-ready", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())})
            await self._persist_state(state)
            provisioning_journaled = True

        try:
            result = await self._run_provisioning(
                transport=_Transport(), net_key=net_key_bytes(state), key_index=0, iv_index=state["ivIndex"],
                unicast_address=lambda caps: allocate_unicast_address(state, max(1, caps["num_elements"])),
                attention_duration_s=attention_duration_s, on_before_data=on_before_data)
        except Exception as error:
            if getattr(error, "provisioning_data_may_have_been_sent", None) is False:
                # Le premier send(DATA) n'a pas commencé : l'allocation et l'éventuel journal sont annulables.
                state["nextUnicastAddress"] = next_unicast_before
                set_pending_provisioning(state, pending_before)
                if provisioning_journaled:
                    await self._persist_state(state)
            elif provisioning_journaled and state.get("pendingProvisioning"):
                pending_node = state["pendingProvisioning"]
                add_node(state, uuid=pending_node["uuid"], name=pending_node.get("name"),
                         unicast_address=pending_node["unicastAddress"], element_count=pending_node["elementCount"],
                         device_key=pending_node["deviceKey"],
                         vendor_element_address=pending_node.get("vendorElementAddress"),
                         configuration_status="provisioning-uncertain", configuration_error=str(error))
                await self._persist_state(state)
            raise
        finally:
            await conn.close()

        node = add_node(state, uuid=target_uuid, name=name, unicast_address=result["unicast_address"],
                        element_count=result["num_elements"], device_key=result["device_key"],
                        configuration_status="pending")
        clear_pending_provisioning(state, node["uuid"])
        await self._persist_state(state)

        # La lampe bascule 0x1827 -> 0x1828 après le Complete, ce qui peut prendre plus de temps que prévu :
        # quelques essais évitent d'échouer tout le provisioning pour un simple délai.
        configure_attempts = 3
        last_configure_error = None
        for attempt in range(1, configure_attempts + 1):
            try:
                await self._configure_node(node)
                last_configure_error = None
                break
            except Exception as error:  # noqa: BLE001
                last_configure_error = error
                log.warning("Configuration post-provisioning échouée (essai %d/%d) : %s", attempt,
                            configure_attempts, error)
                if attempt < configure_attempts:
                    await asyncio.sleep(self._configure_retry_delay_s)

        if last_configure_error:
            node["configurationStatus"] = "pending"
            node["configurationError"] = str(last_configure_error)
            await self._persist_state(state)
            reset_error = None
            try:
                await self._reset_and_remove_node(state, node)
            except Exception as error:  # noqa: BLE001
                # Le Node Reset radio a réussi : seul le retrait durable local est resté en suspens. Ne jamais
                # retomber dans « provisioned: True » ; le journal pendingNodeReset permet la reprise.
                if getattr(error, "code", None) == "NODE_RESET_LOCAL_FINALIZE_FAILED":
                    raise
                reset_error = error
            if reset_error is None:
                raise MeshError("Configuration post-provisioning échouée ; la lampe a été réinitialisée et le "
                                f"nœud local annulé : {last_configure_error}")
            node["configurationStatus"] = "pending"
            node["configurationError"] = f"{last_configure_error}; Node Reset impossible: {reset_error}"
            await self._persist_state(state)
            return {"uuid": node["uuid"], "name": node["name"], "unicast_address": node["unicastAddress"],
                    "element_count": node["elementCount"], "provisioned": True, "configured": False,
                    "configuration_pending": True, "error": node["configurationError"]}

        return {"uuid": node["uuid"], "name": node["name"], "unicast_address": node["unicastAddress"],
                "element_count": node["elementCount"], "provisioned": True, "configured": True,
                "configuration_pending": False}

    # --- node reset / forget -----------------------------------------------------------------

    async def _send_node_reset(self, node):
        async with self._node_lock(node["unicastAddress"]):
            session = await self._ensure_proxy_session()
            try:
                await self._exchange_config_message(session, node, cfg.encode_config_opcode(cfg.NODE_RESET),
                                                    cfg.NODE_RESET_STATUS)
            except Exception:
                # Une réponse tardive ne doit jamais satisfaire une future requête : fermer détruit l'inbox.
                await self._close_proxy()
                raise
            await self._close_proxy()
            return {"reset": True}

    async def _reset_and_remove_node(self, state, node, force_local=False):
        if not self._persist_state:
            raise MeshError("Persistance durable requise avant suppression d'un nœud mesh")
        pending_reset = state.get("pendingNodeReset")
        if not force_local and pending_reset and pending_reset["uuid"] != node["uuid"]:
            raise MeshError(f"Un Node Reset est déjà en attente pour {pending_reset['uuid']} ; finalisez-le avant "
                            "d'en lancer un autre", "SMALLRIG_NODE_RESET_PENDING")
        # Préflight puis intention durable avant l'effet radio irréversible.
        await self._persist_state(state)
        if not force_local:
            state["pendingNodeReset"] = {"uuid": node["uuid"],
                                         "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}
            await self._persist_state(state)
            try:
                await self._send_node_reset(node)
            except Exception as error:  # noqa: BLE001
                raise MeshError(f"Node Reset impossible : {error}", "SMALLRIG_NODE_RESET_FAILED") from error

        previous_nodes = state["nodes"]
        previous_pending_reset = state.get("pendingNodeReset")
        remove_node(state, node["uuid"])
        clear_pending_provisioning(state, node["uuid"])
        if state.get("pendingNodeReset") and state["pendingNodeReset"]["uuid"] == node["uuid"]:
            state["pendingNodeReset"] = None
        try:
            await self._persist_state(state)
        except Exception as error:  # noqa: BLE001
            # Le journal durable permet la reprise ; restaurer aussi la vue runtime.
            state["nodes"] = previous_nodes
            state["pendingNodeReset"] = previous_pending_reset
            raise MeshError(f"Node Reset effectué mais finalisation locale impossible : {error}",
                            "NODE_RESET_LOCAL_FINALIZE_FAILED") from error
        return {"removed": True, "reset": not force_local, "force_local": bool(force_local)}

    async def _forget(self, uuid, force_local=False):
        state = self._get_state()
        node = find_node(state, uuid)
        if not node:
            return {"removed": False, "reset": False, "force_local": bool(force_local)}
        result = await self._reset_and_remove_node(state, node, force_local)
        await self._close_proxy()
        return result

    # --- configuration post-provisioning ----------------------------------------------------

    async def _configure_node(self, node):
        async with self._node_lock(node["unicastAddress"]):
            await self._configure_node_unlocked(node)

    async def _configure_node_unlocked(self, node):
        state = self._get_state()
        pending_reset = state.get("pendingNodeReset")
        if pending_reset and pending_reset["uuid"] == node["uuid"]:
            raise MeshError("Node Reset en attente pour cette lampe ; finalisez l'oubli local avant de la "
                            "reconfigurer")
        net_keys = self._net_keys(state)
        await self._close_proxy()

        # Reconnexion en mode Proxy (0x1828) après le délai de bascule du firmware (peut dépasser les « 1 à 3
        # secondes » annoncées) : un court repos avant de scanner aide à la fiabilité de la détection.
        await asyncio.sleep(self._configure_settle_s)
        proxy_lamps = await self._wait_for_proxy(timeout_ms=15000)
        # Préférer une lampe qui annonce NOTRE Network ID : un candidat étranger ne relayera jamais nos messages.
        expected = net_keys["network_id"]
        exact = [c for c in proxy_lamps if c.network_id and bytes(c.network_id) == expected]
        identity = [c for c in proxy_lamps if not c.network_id]
        ours = exact + identity
        if not ours:
            raise MeshError("Aucun Proxy du réseau SmallRig local détecté (Network ID étranger)")

        conn = None
        session = None
        last_connect_error = None
        provisioner = self._provisioner_address(state)
        for candidate in ours:
            holder = {"session": None}

            def on_data(data, holder=holder):
                if holder["session"] is not None:
                    holder["session"].feed(data)

            candidate_conn = None
            try:
                candidate_conn = await self._open_proxy(candidate, on_data)
                candidate_session = ProxySession(candidate_conn, net_keys, state["ivIndex"], provisioner,
                                                 self._seq_allocator)
                holder["session"] = candidate_session
                await candidate_session.configure_proxy_filter([provisioner])
                conn, session = candidate_conn, candidate_session
                break
            except Exception as error:  # noqa: BLE001
                last_connect_error = error
                if candidate_conn:
                    try:
                        await candidate_conn.close()
                    except Exception:  # noqa: BLE001
                        pass
        if not session or not conn:
            raise last_connect_error or MeshError("Connexion Proxy impossible pour la configuration")

        try:
            composition_response = await self._exchange_config_message(
                session, node, cfg.encode_composition_data_get(0), cfg.COMPOSITION_DATA_STATUS)
            composition = cfg.parse_composition_data_page0(composition_response["params"])
            log.info("Composition Data Page 0 reçue : %s", composition_response["params"].hex())
            if len(composition["elements"]) != node["elementCount"]:
                raise MeshError(f"Composition Data incohérente : {len(composition['elements'])} éléments, "
                                f"{node['elementCount']} attendus")
            vendor_index = next((i for i, element in enumerate(composition["elements"])
                                 if VENDOR_MODEL_ID in element["vendor_models"]), -1)
            if vendor_index < 0 or vendor_index >= node["elementCount"]:
                raise MeshError("Vendor model DATATRANS_SERVER absent de la Composition Data")
            node["vendorElementAddress"] = node["unicastAddress"] + vendor_index

            app_key = app_key_bytes(state)
            response = await self._exchange_config_message(
                session, node, cfg.encode_app_key_add(app_key, 0, 0), cfg.APP_KEY_STATUS)
            app_key_status = cfg.decode_app_key_status(response["params"])
            if not app_key_status["ok"]:
                raise MeshError(f"App Key Add refusé (status {app_key_status['status']})")
            if app_key_status["net_key_index"] != 0 or app_key_status["app_key_index"] != 0:
                raise MeshError("App Key Status ne correspond pas aux index demandés")

            response = await self._exchange_config_message(
                session, node, cfg.encode_model_app_bind(node["vendorElementAddress"], VENDOR_MODEL_ID, 0, True),
                cfg.MODEL_APP_STATUS)
            bind = cfg.decode_model_app_status(response["params"])
            if not bind["ok"]:
                raise MeshError(f"Model App Bind refusé (status {bind['status']})")
            if (bind["element_address"] != node["vendorElementAddress"] or bind["app_key_index"] != 0
                    or not bind["is_vendor_model"] or bind["model_id"] != VENDOR_MODEL_ID):
                raise MeshError("Model App Status ne correspond pas au bind demandé")

            node["configurationStatus"] = "configured"
            node["configurationError"] = None
            clear_pending_provisioning(state, node["uuid"])
            await self._persist_state(state)
            log.info("Nœud configuré (AppKey + Model App Bind) : %s", node["uuid"])
        except Exception as error:
            node["configurationStatus"] = "pending"
            node["configurationError"] = str(error)
            await self._persist_state(state)
            raise
        finally:
            await conn.close()

    # --- commandes de contrôle Lq -----------------------------------------------------------

    async def _send_lq_to_node(self, node, lq_frame):
        state = self._get_state()
        session = await self._ensure_proxy_session()
        app_key = app_key_bytes(state)
        await session.send(src=self._provisioner_address(state),
                           dst=node.get("vendorElementAddress") or node["unicastAddress"], key=app_key,
                           key_type="app", aid=derive_app_key_aid(app_key),
                           access_payload=lq.build_vendor_access_payload(lq_frame))

    async def _read_lq_from_node(self, node, read_frame, decode_response, timeout_s=COMMAND_RESPONSE_TIMEOUT_S,
                                 close_on_timeout=True):
        """`close_on_timeout` casse la session Proxy après un échec de lecture (le protocole Lq n'a pas d'identifiant
        de transaction : seule une nouvelle session garantit qu'une réponse tardive ne satisfera pas la lecture
        suivante). Un appelant best-effort peut passer False pour ne pas payer un re-scan complet."""
        node_address = node.get("vendorElementAddress") or node["unicastAddress"]
        async with self._node_lock(node_address):
            state = self._get_state()
            session = await self._ensure_proxy_session()
            app_key = app_key_bytes(state)
            aid = derive_app_key_aid(app_key)
            src = self._provisioner_address(state)
            session.clear_inbox(node_address)
            try:
                await session.send(src=src, dst=node_address, key=app_key, key_type="app", aid=aid,
                                   access_payload=lq.build_vendor_access_payload(read_frame))

                def match(decrypted):
                    if decrypted[0] != lq.VENDOR_SUBOPCODE_DATA:
                        return None
                    return decode_response(decrypted[1:])

                return await self._receive_access_matching(session, source=node_address, destination=src,
                                                           key=app_key, expected_key_type="app", expected_aid=aid,
                                                           timeout_s=timeout_s, match=match)
            except Exception:
                if close_on_timeout:
                    await self._close_proxy()
                raise

    def _resolve_nodes(self, uuids):
        state = self._get_state()
        nodes = [(uuid, find_node(state, uuid)) for uuid in uuids]
        unknown = [uuid for uuid, node in nodes if not node]
        if unknown:
            raise MeshError(f"Lampes inconnues ou non provisionnées : {', '.join(unknown)}")
        if not nodes:
            raise MeshError("Aucune lampe cible connue")
        pending_reset = state.get("pendingNodeReset")
        reset_pending = [uuid for uuid, node in nodes if pending_reset and pending_reset["uuid"] == node["uuid"]]
        if reset_pending:
            raise MeshError(f"Node Reset en attente pour ces lampes : {', '.join(reset_pending)}")
        not_configured = [uuid for uuid, node in nodes if node["configurationStatus"] != "configured"]
        if not_configured:
            raise MeshError(f"Lampes non configurées (reconfigure requis) : {', '.join(not_configured)}")
        return [node for _, node in nodes]

    async def _for_each_node(self, uuids, function):
        results = []
        for node in self._resolve_nodes(uuids):
            try:
                results.append({"uuid": node["uuid"], "ok": True, "result": await function(node)})
            except Exception as error:  # noqa: BLE001
                results.append({"uuid": node["uuid"], "ok": False, "error": str(error)})
        return results

    async def _set_hsi(self, uuids, hue, sat, intensity):
        return await self._for_each_node(uuids, lambda node: self._send_lq_to_node(node, lq.encode_hsi(hue, sat, intensity)))

    async def _set_cct(self, uuids, kelvin, intensity, gm=0):
        return await self._for_each_node(uuids, lambda node: self._send_lq_to_node(node, lq.encode_cct(kelvin, intensity, gm)))

    async def _set_rgbw(self, uuids, r, g, b, w=0):
        return await self._for_each_node(uuids, lambda node: self._send_lq_to_node(node, lq.encode_rgbw(r, g, b, w)))

    async def _set_fx(self, uuids, mode, param1=0, param2=0):
        return await self._for_each_node(uuids, lambda node: self._send_lq_to_node(node, lq.encode_fx(mode, param1, param2)))

    async def _set_power(self, uuids, on, level=None):
        if on is False:
            frame = lq.encode_lum_off()
        elif isinstance(level, (int, float)) and not isinstance(level, bool):
            frame = lq.encode_lum_level(level)
        else:
            frame = lq.encode_lum_on()
        return await self._for_each_node(uuids, lambda node: self._send_lq_to_node(node, frame))

    async def _read_status(self, uuid, **options):
        (node,) = self._resolve_nodes([uuid])
        return await self._read_lq_from_node(node, lq.encode_status_read(), lq.decode_status, **options)

    async def _read_capacity(self, uuid, **options):
        (node,) = self._resolve_nodes([uuid])
        return await self._read_lq_from_node(node, lq.encode_capacity_read(), lq.decode_capacity, **options)

    async def _read_version(self, uuid, **options):
        (node,) = self._resolve_nodes([uuid])

        def decode(params):
            if "_V" not in lq.strip_at_prefix(params).decode("latin1"):
                raise MeshError("Réponse version inattendue")
            return lq.decode_version(params)

        return await self._read_lq_from_node(node, lq.encode_version_read(), decode, **options)

    # --- API publique (toutes les opérations sont sérialisées) -------------------------------

    async def _serialized(self, function, *args, **kwargs):
        async with self._operation_lock:
            return await function(*args, **kwargs)

    async def discover(self, timeout_ms=6000):
        return await self._serialized(self._discover, timeout_ms)

    async def provision(self, **kwargs):
        return await self._serialized(self._provision, **kwargs)

    async def forget(self, uuid, force_local=False):
        return await self._serialized(self._forget, uuid, force_local)

    async def configure_node(self, node):
        return await self._serialized(self._configure_node, node)

    async def set_hsi(self, uuids, hue, sat, intensity):
        return await self._serialized(self._set_hsi, uuids, hue, sat, intensity)

    async def set_cct(self, uuids, kelvin, intensity, gm=0):
        return await self._serialized(self._set_cct, uuids, kelvin, intensity, gm)

    async def set_rgbw(self, uuids, r, g, b, w=0):
        return await self._serialized(self._set_rgbw, uuids, r, g, b, w)

    async def set_fx(self, uuids, mode, param1=0, param2=0):
        return await self._serialized(self._set_fx, uuids, mode, param1, param2)

    async def set_power(self, uuids, on, level=None):
        return await self._serialized(self._set_power, uuids, on, level)

    async def read_status(self, uuid, **options):
        return await self._serialized(self._read_status, uuid, **options)

    async def read_capacity(self, uuid, **options):
        return await self._serialized(self._read_capacity, uuid, **options)

    async def read_version(self, uuid, **options):
        return await self._serialized(self._read_version, uuid, **options)

    def list_nodes(self):
        state = self._get_state()
        pending_reset = state.get("pendingNodeReset")
        return [{"uuid": node["uuid"], "name": node["name"], "unicast_address": node["unicastAddress"],
                 "vendor_element_address": node.get("vendorElementAddress") or node["unicastAddress"],
                 "configuration_status": node.get("configurationStatus") or "unknown",
                 "configuration_pending": node.get("configurationStatus") != "configured",
                 "configuration_error": node.get("configurationError"),
                 "reset_pending": bool(pending_reset and pending_reset["uuid"] == node["uuid"])}
                for node in state["nodes"]]

    @property
    def connected(self):
        return bool(self._proxy_session and self._proxy_session.connected)

    async def connect(self):
        """Ouvre (ou vérifie) la session Proxy sans envoyer de commande."""
        await self._serialized(self._ensure_proxy_session)

    async def stop(self):
        await self._serialized(self._close_proxy)
