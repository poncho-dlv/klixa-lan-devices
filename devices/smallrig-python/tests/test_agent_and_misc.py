"""Branchement sur le protocole des appareils LAN (contre un faux compagnon), configuration, fichier d'état,
conversions de couleur et lecture des annonces BLE."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402
from fake_mesh import FakeBle, FakeLamp  # noqa: E402
from test_mesh_client import make_state, run  # noqa: E402

from klixa_device_agent import PROTOCOL_VERSION_LIGHT  # noqa: E402
from klixa_smallrig import lamps as lamps_module  # noqa: E402
from klixa_smallrig import lq_protocol as lq  # noqa: E402
from klixa_smallrig import store  # noqa: E402
from klixa_smallrig.agent import build_agent  # noqa: E402
from klixa_smallrig.ble import LampAdvertisement, parse_lamp_advertisement, uuid_string  # noqa: E402
from klixa_smallrig.config import load_config, load_dotenv  # noqa: E402
from klixa_smallrig.state_file import atomic_write, load_persisted_state  # noqa: E402


class FakeCompanion:
    def __init__(self, commands):
        self.commands, self.hello, self.acks = commands, None, []

    async def handler(self, ws, *_):
        self.hello = json.loads(await ws.recv())
        await ws.send(json.dumps({"type": "registered", "ok": True}))
        for command in self.commands:  # une commande à la fois : le compagnon attend l'ack avant la suivante
            await ws.send(json.dumps({"type": "command", **command}))
            self.acks.append(json.loads(await ws.recv()))
        await ws.close()


class AgentTests(unittest.TestCase):
    def test_each_paired_lamp_is_announced_and_driven_through_the_lan_device_protocol(self):
        lamp = FakeLamp()
        state = make_state(lamp)
        ble = FakeBle([lamp], lambda: controller._state)

        async def persist(_json):
            return None

        controller = lamps_module.LampController(mesh_state_json=store.serialize_mesh_state(state), ble=ble,
                                                 on_state_change=persist)
        uuid = lamp.device_uuid.hex()
        config = SimpleNamespace(companion_url="ws://x", device_token="kxd_t", device_id="smallrig",
                                 device_name="Lampes SmallRig")
        agent = build_agent(config, controller)

        async def scenario():
            companion = FakeCompanion([
                {"id": "c1", "elementId": uuid, "action": "set", "payload": {"on": True, "color": "#FF0000",
                                                                            "brightness": 50}, "data": {}},
                {"id": "c2", "elementId": uuid, "action": "getState", "payload": {}, "data": {}},
            ])
            async with websockets.serve(companion.handler, "127.0.0.1", 0) as server:
                agent.companion_url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/devices/ws"
                await asyncio.wait_for(agent._run_once(), timeout=15)
            await controller.stop()
            return companion

        companion = run(scenario())
        element = companion.hello["elements"][0]
        self.assertEqual(companion.hello["protocolVersion"], PROTOCOL_VERSION_LIGHT)
        self.assertEqual((element["id"], element["type"], element["name"]), (uuid, "light", "Lampe 0"))
        self.assertEqual(element["actions"], ["set", "getState"])
        self.assertEqual(element["capabilities"], ["onoff", "dimming", "color", "color_temperature"])
        self.assertEqual(element["kelvin"], {"min": 2500, "max": 10000})
        self.assertEqual([m["id"] for m in element["fxModes"]], [str(i) for i in range(1, 13)])
        self.assertEqual(companion.acks[0], {"type": "ack", "id": "c1", "ok": True, "result": {"applied": True}})
        self.assertEqual(companion.acks[1]["result"], {"on": True, "color": "#FF0000", "brightness": 50})
        self.assertEqual(lamp.received_lq, [lq.encode_hsi(0, 100, 50)])


class KeepConnectedTests(unittest.TestCase):
    def test_reconnects_when_the_session_drops_and_backs_off_on_failures(self):
        class Controller:
            def __init__(self):
                self.is_connected, self.calls, self.fail = False, 0, 1

            def list(self):
                return [1]

            @property
            def connected(self):
                return self.is_connected

            async def ensure_connected(self):
                self.calls += 1
                if self.fail:
                    self.fail -= 1
                    raise RuntimeError("lampe éteinte")
                self.is_connected = True

        async def scenario():
            controller = Controller()
            task = asyncio.ensure_future(lamps_module.keep_connected(controller, interval_s=0.01, max_backoff_s=0.05))
            await asyncio.sleep(0.15)
            first = (controller.calls, controller.connected)
            controller.is_connected = False  # la connexion tombe
            await asyncio.sleep(0.15)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return first, controller.calls

        first, calls = run(scenario())
        self.assertEqual(first, (2, True))  # un échec, puis la connexion
        self.assertEqual(calls, 3)  # et une reconnexion après la coupure

    def test_nothing_is_done_without_a_paired_lamp(self):
        class Empty:
            connected = False

            def list(self):
                return []

            async def ensure_connected(self):
                raise AssertionError("ne doit pas être appelé")

        async def scenario():
            task = asyncio.ensure_future(lamps_module.keep_connected(Empty(), interval_s=0.01))
            await asyncio.sleep(0.05)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        run(scenario())


class ColorTests(unittest.TestCase):
    def test_hex_to_hue_sat_matches_node(self):
        expected = {"#FF0000": (0, 100), "#00FF00": (120, 100), "#0000FF": (240, 100), "#FFFFFF": (0, 0),
                    "#000000": (0, 0), "#FF8800": (32, 100), "#3A7CA5": (203, 65), "#7FB3D5": (204, 40),
                    "#123456": (210, 79), "#FEDCBA": (30, 27), "#808080": (0, 0), "#C0FFEE": (164, 25)}
        for color, value in expected.items():
            self.assertEqual(lamps_module.hex_to_hue_sat(color), value, color)

    def test_hue_sat_to_hex_matches_node(self):
        expected = [(0, 100, "#FF0000"), (60, 100, "#FFFF00"), (120, 50, "#80FF80"), (200, 80, "#33BBFF"),
                    (359, 100, "#FF0004"), (360, 40, "#FF9999"), (-30, 70, "#FF4DA6"), (180, 0, "#FFFFFF")]
        for hue, sat, color in expected:
            self.assertEqual(lamps_module.hue_sat_to_hex(hue, sat), color, (hue, sat))

    def test_baseline_to_payload(self):
        f = lamps_module.baseline_to_payload
        self.assertEqual(f(None), {"on": True})
        self.assertEqual(f({"poweredOn": False, "status": None}), {"on": False})
        self.assertEqual(f({"poweredOn": True, "status": {"type": "cct", "kelvin": 4000, "intensity": 70}}),
                         {"on": True, "kelvin": 4000, "brightness": 70})
        self.assertEqual(f({"poweredOn": True, "status": {"type": "rgbw", "r": 255, "g": 0, "b": 16, "w": 0}}),
                         {"on": True, "color": "#FF0010"})
        self.assertEqual(f({"poweredOn": True, "status": {"type": "fx", "mode": 4}}), {"on": True, "fx": "4"})
        self.assertEqual(f({"poweredOn": True, "status": {"type": "hsi", "hue": 0, "sat": 100, "intensity": 9}}),
                         {"on": True, "color": "#FF0000", "brightness": 9})

    def test_merge_baseline_and_results_assertion(self):
        merged = lamps_module.merge_baseline({"status": {"type": "fx"}, "poweredOn": True}, {"poweredOn": False})
        self.assertEqual(merged, {"status": {"type": "fx"}, "poweredOn": False})
        with self.assertRaises(lamps_module.LampCommandError):
            lamps_module.assert_light_command_results("Test", "u", [[{"ok": False, "error": "boom"}]])
        with self.assertRaises(lamps_module.LampCommandError):
            lamps_module.assert_light_command_results("Test", "u", [[]])


class ConfigAndStateFileTests(unittest.TestCase):
    def test_config_defaults_and_overrides(self):
        config = load_config({})
        self.assertEqual((config.device_id, config.max_lamps, config.seq_block_size, config.companion_url),
                         ("smallrig", 50, 100, "ws://127.0.0.1:8786/devices/ws"))
        config = load_config({"DEVICE_TOKEN": " kxd_x ", "SMALLRIG_MAX_LAMPS": "7", "SMALLRIG_SEQ_BLOCK_SIZE": "oops",
                              "SMALLRIG_KEEP_CONNECTED": "0"})
        self.assertEqual((config.device_token, config.max_lamps, config.seq_block_size, config.keep_connected),
                         ("kxd_x", 7, 100, False))
        self.assertTrue(load_config({}).keep_connected)

    def test_dotenv_does_not_override_the_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".env"
            path.write_text("# commentaire\nKX_TEST_A=1\nKX_TEST_B='deux'\nKX_TEST_C=3\n", encoding="utf-8")
            os.environ["KX_TEST_C"] = "déjà posé"
            try:
                load_dotenv(path)
                self.assertEqual((os.environ["KX_TEST_A"], os.environ["KX_TEST_B"], os.environ["KX_TEST_C"]),
                                 ("1", "deux", "déjà posé"))
            finally:
                for key in ("KX_TEST_A", "KX_TEST_B", "KX_TEST_C"):
                    os.environ.pop(key, None)

    def test_state_file_is_written_atomically_and_reloaded(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "sub" / "state.json"
            self.assertEqual(load_persisted_state(file), "")
            atomic_write(file, '{"a": 1}\n')
            self.assertEqual(load_persisted_state(file), '{"a": 1}')
            atomic_write(file, '{"a": 2}\n')
            self.assertEqual(json.loads(file.read_text(encoding="utf-8")), {"a": 2})
            self.assertEqual([p.name for p in file.parent.iterdir()], ["state.json"])  # pas de fichier temporaire
            if os.name != "nt":
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            file.write_text("", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                load_persisted_state(file)

    def test_node_written_state_is_readable(self):
        """Le format est celui de la version Node.js : un fichier produit par l'une est relu par l'autre."""
        node_state = json.dumps({"netKey": "00" * 16, "appKey": "11" * 16, "ivIndex": 0, "provisionerAddress": 1,
                                 "nextUnicastAddress": 3, "seq": 0, "seqAllocatedUpTo": 100, "pendingProvisioning": None,
                                 "pendingNodeReset": None,
                                 "nodes": [{"uuid": "ab" * 16, "name": "Bureau", "unicastAddress": 2, "elementCount": 1,
                                            "deviceKey": "22" * 16, "vendorElementAddress": 2,
                                            "configurationStatus": "configured", "configurationError": None}]})
        state = store.parse_mesh_state(node_state)
        self.assertEqual((state["seq"], state["nodes"][0]["name"]), (100, "Bureau"))


class AdvertisementTests(unittest.TestCase):
    device = SimpleNamespace(address="AA:BB", name="RM75")

    def test_unprovisioned_lamp(self):
        data = {uuid_string(0x1827): bytes(range(16)) + b"\x00\x00"}
        lamp = parse_lamp_advertisement(self.device, data, -40)
        self.assertEqual((lamp.kind, lamp.device_uuid, lamp.rssi), ("unprovisioned", bytes(range(16)), -40))

    def test_provisioned_lamp_with_network_id_or_node_identity(self):
        with_network = parse_lamp_advertisement(self.device, {uuid_string(0x1828): b"\x00" + bytes(range(8))})
        self.assertEqual((with_network.kind, with_network.network_id), ("provisioned", bytes(range(8))))
        identity = parse_lamp_advertisement(self.device, {uuid_string(0x1828): b"\x01" + bytes(16)})
        self.assertEqual((identity.kind, identity.network_id), ("provisioned", None))

    def test_proxy_prevails_when_both_services_were_seen(self):
        both = {uuid_string(0x1827): bytes(16), uuid_string(0x1828): b"\x00" + bytes(8)}
        self.assertEqual(parse_lamp_advertisement(self.device, both).kind, "provisioned")

    def test_other_devices_are_ignored(self):
        self.assertIsNone(parse_lamp_advertisement(self.device, {}))
        self.assertIsNone(parse_lamp_advertisement(self.device, {uuid_string(0x180F): b"\x01"}))
        self.assertIsNone(parse_lamp_advertisement(self.device, {uuid_string(0x1827): b"\x01"}))
        self.assertIsInstance(LampAdvertisement("x", "provisioned"), LampAdvertisement)


if __name__ == "__main__":
    unittest.main()
