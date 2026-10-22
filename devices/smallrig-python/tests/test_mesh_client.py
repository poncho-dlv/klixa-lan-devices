"""`MeshClient` et `LampController` de bout en bout contre un firmware RM75 simulé (vraies couches mesh)."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_mesh import FakeBle, FakeLamp  # noqa: E402

from klixa_smallrig import lq_protocol as lq  # noqa: E402
from klixa_smallrig import mesh_client, store  # noqa: E402
from klixa_smallrig.lamps import LampCommandError, LampController  # noqa: E402

KEY = "00112233445566778899aabbccddeeff"
APP = "f0e1d2c3b4a5968778695a4b3c2d1e0f"


def make_state(*lamps):
    """État mesh avec un nœud configuré par lampe simulée (adresses 2, 3...)."""
    state = store.create_empty_mesh_state()
    state.update(netKey=KEY, appKey=APP)
    for index, lamp in enumerate(lamps):
        address = 2 + index
        store.add_node(state, uuid=lamp.device_uuid.hex(), name=f"Lampe {index}", unicast_address=address,
                       element_count=1, device_key=bytes([index + 1]) * 16, configuration_status="configured")
        state["nextUnicastAddress"] = address + 1
        lamp.adopt(state, state["nodes"][-1])
    return state


class Harness:
    def __init__(self, *lamps, state=None):
        self.lamps = list(lamps)
        self.state = state if state is not None else make_state(*lamps)
        self.persisted = 0
        self.ble = FakeBle(self.lamps, lambda: self.state)
        self.client = mesh_client.MeshClient(
            get_state=lambda: self.state, persist_state=self.persist,
            scan_for_lamp_advertisements=self.ble.scan_for_lamp_advertisements,
            open_provisioning_connection=self.ble.open_provisioning_connection,
            open_proxy_connection=self.ble.open_proxy_connection,
            wait_for_proxy_advertisement=self.ble.wait_for_proxy_advertisement,
            seq_block_size=10, configure_settle_s=0, configure_retry_delay_s=0)

    async def persist(self, state):
        self.persisted += 1


def run(coroutine):
    return asyncio.run(asyncio.wait_for(coroutine, 30))


class ControlTests(unittest.TestCase):
    def test_commands_reach_the_lamp_as_lq_frames_over_one_proxy_session(self):
        lamp = FakeLamp()
        harness = Harness(lamp)

        async def scenario():
            uuid = lamp.device_uuid.hex()
            results = [
                await harness.client.set_hsi([uuid], 200, 80, 55),
                await harness.client.set_cct([uuid], 5600, 70, -3),
                await harness.client.set_power([uuid], on=False),
                await harness.client.set_power([uuid], on=True, level=40),
                await harness.client.set_fx([uuid], 2, 0, 0),
                await harness.client.set_rgbw([uuid], 1, 2, 3, 4),
            ]
            await harness.client.stop()
            return results

        results = run(scenario())
        self.assertTrue(all(r[0]["ok"] for r in results), results)
        self.assertEqual(lamp.received_lq, [lq.encode_hsi(200, 80, 55), lq.encode_cct(5600, 70, -3),
                                            lq.encode_lum_off(), lq.encode_lum_level(40), lq.encode_fx(2, 0, 0),
                                            lq.encode_rgbw(1, 2, 3, 4)])
        self.assertEqual(harness.ble.proxy_opens, 1)  # une seule session GATT réutilisée
        self.assertEqual(lamp.proxy_filter, [1])  # le filtre Proxy ne laisse passer que le provisioner

    def test_sequence_numbers_are_persisted_before_each_new_block_and_never_reused(self):
        lamp = FakeLamp()
        harness = Harness(lamp)

        async def scenario():
            for _ in range(12):
                await harness.client.set_power([lamp.device_uuid.hex()], on=True)
            await harness.client.stop()

        run(scenario())
        self.assertGreaterEqual(harness.persisted, 2)  # blocs de 10 : au moins deux franchissements
        self.assertLessEqual(harness.state["seq"], harness.state["seqAllocatedUpTo"])
        self.assertGreater(harness.state["seq"], 12)

    def test_read_status_and_capacity(self):
        lamp = FakeLamp()
        harness = Harness(lamp)

        async def scenario():
            uuid = lamp.device_uuid.hex()
            status = await harness.client.read_status(uuid)
            capacity = await harness.client.read_capacity(uuid)
            await harness.client.stop()
            return status, capacity

        status, capacity = run(scenario())
        self.assertEqual(status, {"type": "hsi", "hue": 200, "sat": 80, "intensity": 55})
        self.assertEqual((capacity["battery"], capacity["powered_on"]), (85, True))

    def test_unknown_or_unconfigured_lamps_are_refused_per_lamp(self):
        lamp = FakeLamp()
        harness = Harness(lamp)
        harness.state["nodes"][0]["configurationStatus"] = "pending"

        async def scenario():
            with self.assertRaises(mesh_client.MeshError):
                await harness.client.set_power(["f" * 32], on=True)
            with self.assertRaises(mesh_client.MeshError):
                await harness.client.set_power([lamp.device_uuid.hex()], on=True)

        run(scenario())

    def test_a_lamp_that_does_not_answer_times_out_and_the_session_is_rebuilt(self):
        lamp = FakeLamp()
        harness = Harness(lamp)
        lamp.status_frame = b""  # inutilisé : on coupe simplement la réponse

        async def scenario():
            uuid = lamp.device_uuid.hex()
            await harness.client.set_power([uuid], on=True)  # ouvre la session
            original = lamp._handle_lq
            lamp._handle_lq = lambda conn, src, payload: lamp.received_lq.append(payload[1:])  # ne répond plus
            with self.assertRaises(mesh_client.MeshTimeout):
                await harness.client.read_status(uuid, timeout_s=0.3)
            lamp._handle_lq = original
            await harness.client.set_power([uuid], on=False)  # nouvelle session
            await harness.client.stop()

        run(scenario())
        self.assertEqual(harness.ble.proxy_opens, 2)

    def test_discover_hides_lamps_already_paired(self):
        paired, fresh = FakeLamp(), FakeLamp()
        harness = Harness(paired)
        harness.ble.lamps.append(fresh)  # une seconde lampe, non provisionnée

        found = run(harness.client.discover())
        kinds = sorted((lamp["kind"], lamp.get("ours")) for lamp in found)
        self.assertEqual(kinds, [("provisioned", True), ("unprovisioned", None)])
        fresh.provisioned = False
        harness.state["nodes"].append({**harness.state["nodes"][0], "uuid": fresh.device_uuid.hex(),
                                       "unicastAddress": 9})
        found = run(harness.client.discover())
        self.assertEqual([lamp["kind"] for lamp in found], ["provisioned"])


class ProvisioningFlowTests(unittest.TestCase):
    def test_pairing_a_new_lamp_provisions_configures_and_persists_it(self):
        lamp = FakeLamp()
        harness = Harness(state=store.create_empty_mesh_state())
        harness.lamps.append(lamp)
        harness.ble.lamps = harness.lamps

        async def scenario():
            found = await harness.client.discover()
            target = found[0]
            result = await harness.client.provision(ble_device_id=target["ble_device_id"],
                                                    device_uuid=target["device_uuid"], name="Bureau")
            uuid = result["uuid"]
            control = await harness.client.set_hsi([uuid], 10, 20, 30)
            await harness.client.stop()
            return result, control

        result, control = run(scenario())
        self.assertTrue(result["provisioned"] and result["configured"], result)
        node = harness.state["nodes"][0]
        self.assertEqual((node["configurationStatus"], node["name"], node["unicastAddress"]),
                         ("configured", "Bureau", 2))
        self.assertEqual(node["deviceKey"], lamp.device_key.hex())  # même DevKey des deux côtés
        self.assertEqual(lamp.app_key.hex(), harness.state["appKey"])  # AppKey distribuée par Config AppKey Add
        self.assertIsNone(harness.state["pendingProvisioning"])
        self.assertTrue(control[0]["ok"])
        self.assertEqual(lamp.received_lq, [lq.encode_hsi(10, 20, 30)])

    def test_a_failed_configuration_resets_the_lamp_and_forgets_the_node(self):
        lamp = FakeLamp(fail_composition=True)
        harness = Harness(state=store.create_empty_mesh_state())
        harness.lamps.append(lamp)
        original = mesh_client.CONFIG_RESPONSE_TIMEOUT_S
        mesh_client.CONFIG_RESPONSE_TIMEOUT_S = 0.3
        try:
            async def scenario():
                found = await harness.client.discover()
                with self.assertRaises(mesh_client.MeshError) as caught:
                    await harness.client.provision(ble_device_id=found[0]["ble_device_id"],
                                                   device_uuid=found[0]["device_uuid"])
                await harness.client.stop()
                return caught.exception

            error = run(scenario())
        finally:
            mesh_client.CONFIG_RESPONSE_TIMEOUT_S = original
        self.assertIn("réinitialisée", str(error))
        self.assertEqual(lamp.reset_count, 1)
        self.assertEqual(harness.state["nodes"], [])
        self.assertIsNone(harness.state["pendingNodeReset"])

    def test_forget_resets_the_lamp_then_removes_the_node(self):
        lamp = FakeLamp()
        harness = Harness(lamp)

        async def scenario():
            result = await harness.client.forget(lamp.device_uuid.hex())
            missing = await harness.client.forget("e" * 32)
            await harness.client.stop()
            return result, missing

        result, missing = run(scenario())
        self.assertEqual(result, {"removed": True, "reset": True, "force_local": False})
        self.assertFalse(missing["removed"])
        self.assertEqual((lamp.reset_count, harness.state["nodes"]), (1, []))

    def test_forget_force_local_does_not_talk_to_the_lamp(self):
        lamp = FakeLamp()
        harness = Harness(lamp)
        result = run(harness.client.forget(lamp.device_uuid.hex(), force_local=True))
        self.assertEqual(result["reset"], False)
        self.assertEqual((lamp.reset_count, harness.ble.proxy_opens), (0, 0))


class ControllerTests(unittest.TestCase):
    def make(self):
        lamp = FakeLamp()
        state = make_state(lamp)
        ble = FakeBle([lamp], lambda: controller._state)
        controller = LampController(mesh_state_json=store.serialize_mesh_state(state), ble=ble,
                                    on_state_change=self._noop)
        return lamp, controller

    @staticmethod
    async def _noop(_json):
        return None

    def test_set_state_maps_the_lan_light_payload_to_lq_frames(self):
        lamp, controller = self.make()
        uuid = lamp.device_uuid.hex()

        async def scenario():
            for state in ({"on": True, "color": "#FF8800", "brightness": 60}, {"on": True, "kelvin": 4000},
                          {"on": True, "brightness": 30}, {"on": True}, {"on": True, "fx": "5"}, {"on": False}):
                self.assertEqual(await controller.set_state(uuid, state), {"applied": True})
            await controller.stop()

        run(scenario())
        self.assertEqual(lamp.received_lq, [lq.encode_hsi(32, 100, 60), lq.encode_cct(4000, 85, 0),
                                            lq.encode_lum_level(30), lq.encode_lum_on(), lq.encode_fx(5, 0, 0),
                                            lq.encode_lum_off()])

    def test_get_state_returns_the_last_written_state_for_restoration(self):
        lamp, controller = self.make()
        uuid = lamp.device_uuid.hex()

        async def scenario():
            await controller.set_state(uuid, {"on": True, "color": "#00FF00", "brightness": 70})
            colored = await controller.get_state(uuid)
            await controller.set_state(uuid, {"on": False})
            off = await controller.get_state(uuid)
            await controller.stop()
            return colored, off

        colored, off = run(scenario())
        self.assertEqual(colored, {"on": True, "color": "#00FF00", "brightness": 70})
        self.assertEqual(off, {"on": False})

    def test_get_state_without_history_reads_the_lamp(self):
        lamp, controller = self.make()

        async def scenario():
            state = await controller.get_state(lamp.device_uuid.hex())
            await controller.stop()
            return state

        state = run(scenario())
        self.assertEqual(state, {"on": True, "color": "#33BBFF", "brightness": 55})

    def test_invalid_requests_are_refused(self):
        lamp, controller = self.make()

        async def scenario():
            with self.assertRaises(LampCommandError):
                await controller.set_state("d" * 32, {"on": True})
            with self.assertRaises(LampCommandError):
                await controller.set_state(lamp.device_uuid.hex(), {"on": True, "fx": "99"})
            await controller.stop()

        run(scenario())

    def test_status_reports_errors_instead_of_raising(self):
        lamp, controller = self.make()

        async def scenario():
            report = await controller.status(lamp.device_uuid.hex())
            await controller.stop()
            return report

        report = run(scenario())
        self.assertEqual(report["state"]["type"], "hsi")
        self.assertEqual(report["capacity"]["battery"], 85)


if __name__ == "__main__":
    unittest.main()
