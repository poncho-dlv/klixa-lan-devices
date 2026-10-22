"""État mesh persistant et provisioning (Provisioner contre un appareil simulé en mémoire)."""
import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from klixa_smallrig import provisioning, store  # noqa: E402
from klixa_smallrig.mesh_client import AsyncQueue  # noqa: E402

UUID_A = "a" * 32
UUID_B = "b" * 32
KEY = "00112233445566778899aabbccddeeff"


def node(uuid=UUID_A, address=2, count=1, **extra):
    return {"uuid": uuid, "unicastAddress": address, "elementCount": count, "deviceKey": KEY,
            "configurationStatus": "configured", **extra}


def state_json(**overrides):
    base = {"netKey": KEY, "appKey": KEY, "ivIndex": 0, "nextUnicastAddress": 3, "seq": 5, "seqAllocatedUpTo": 5,
            "nodes": [node()]}
    base.update(overrides)
    return json.dumps(base)


class StoreTests(unittest.TestCase):
    def test_empty_state(self):
        state = store.parse_mesh_state("")
        self.assertEqual((state["nodes"], state["seq"], state["nextUnicastAddress"]), ([], 0, 2))

    def test_round_trip_keeps_nodes_normalized(self):
        state = store.parse_mesh_state(state_json())
        self.assertEqual(state["nodes"][0]["vendorElementAddress"], 2)
        again = store.parse_mesh_state(store.serialize_mesh_state(state))
        self.assertEqual(again["nodes"], state["nodes"])

    def test_resumes_at_the_durable_seq_bound_after_a_crash(self):
        state = store.parse_mesh_state(state_json(seq=10, seqAllocatedUpTo=110))
        self.assertEqual((state["seq"], state["seqAllocatedUpTo"]), (110, 110))

    def test_rejects_invalid_states(self):
        for bad in (state_json(netKey=None), state_json(nextUnicastAddress=2), state_json(seq=9, seqAllocatedUpTo=3),
                    state_json(nodes=[node(), node()]), state_json(nodes=[node(), node(UUID_B, 2)]),
                    state_json(provisionerAddress=2), "[]", "{pas du json"):
            with self.assertRaises(store.MeshStateError, msg=bad):
                store.parse_mesh_state(bad)

    def test_pending_provisioning_becomes_an_uncertain_node(self):
        pending = {"uuid": UUID_B, "unicastAddress": 3, "elementCount": 1, "deviceKey": KEY}
        state = store.parse_mesh_state(state_json(nextUnicastAddress=4, pendingProvisioning=pending))
        uncertain = [n for n in state["nodes"] if n["uuid"] == UUID_B][0]
        self.assertEqual(uncertain["configurationStatus"], "provisioning-uncertain")

    def test_next_seq_reserves_blocks_and_flags_the_crossing(self):
        state = store.create_empty_mesh_state()
        self.assertEqual(store.next_seq(state, 3), (0, True))
        self.assertEqual(state["seqAllocatedUpTo"], 3)
        self.assertEqual(store.next_seq(state, 3), (1, False))
        self.assertEqual(store.next_seq(state, 3), (2, False))
        self.assertEqual(store.next_seq(state, 3), (3, True))
        state["seq"] = store.MAX_SEQ + 1
        with self.assertRaises(store.SeqExhaustedError):
            store.next_seq(state)

    def test_allocate_unicast_skips_the_provisioner_and_detects_exhaustion(self):
        state = store.create_empty_mesh_state()
        state["provisionerAddress"] = 5
        state["nextUnicastAddress"] = 4
        self.assertEqual(store.allocate_unicast_address(state, 2), 6)
        self.assertEqual(state["nextUnicastAddress"], 8)
        state["nextUnicastAddress"] = store.MAX_UNICAST_ADDRESS
        with self.assertRaises(ValueError):
            store.allocate_unicast_address(state, 2)

    def test_keys_are_generated_once(self):
        state = store.ensure_network_keys(store.create_empty_mesh_state())
        first = (state["netKey"], state["appKey"])
        store.ensure_network_keys(state)
        self.assertEqual((state["netKey"], state["appKey"]), first)
        self.assertEqual(len(store.net_key_bytes(state)), 16)

    def test_node_helpers(self):
        state = store.parse_mesh_state(state_json())
        self.assertIsNotNone(store.find_node(state, UUID_A))
        self.assertTrue(store.remove_node(state, UUID_A))
        self.assertFalse(store.remove_node(state, UUID_A))


class Pipe:
    """Deux extrémités reliées en mémoire (type, params)."""

    def __init__(self):
        self.to_device, self.to_provisioner = AsyncQueue(), AsyncQueue()

    def provisioner_side(self):
        pipe = self

        class Side:
            async def send(self, pdu_type, params):
                pipe.to_device.push(bytes([pdu_type]) + bytes(params))

            async def receive(self, expected_type):
                raw = await pipe.to_provisioner.shift(5)
                assert raw[0] == expected_type
                return raw[1:]

        return Side()

    def device_side(self):
        pipe = self

        class Side:
            async def send(self, pdu_type, params):
                pipe.to_provisioner.push(bytes([pdu_type]) + bytes(params))

            async def receive(self, expected_type):
                raw = await pipe.to_device.shift(5)
                assert raw[0] == expected_type
                return raw[1:]

        return Side()


CAPS = {"num_elements": 2, "algorithms": 1, "public_key_type": 0, "static_oob_type": 0, "output_oob_size": 0,
        "output_oob_action": 0, "input_oob_size": 0, "input_oob_action": 0}


class ProvisioningTests(unittest.TestCase):
    def test_full_exchange_agrees_on_the_device_key_and_delivers_the_network(self):
        async def scenario():
            pipe = Pipe()
            journaled = []

            async def before(result):
                journaled.append(result["device_key"])

            net_key = bytes(range(16))
            device_task = asyncio.ensure_future(provisioning.simulate_device_side(transport=pipe.device_side(),
                                                                                  capabilities=CAPS))
            result = await provisioning.run_provisioning(
                transport=pipe.provisioner_side(), net_key=net_key, iv_index=7,
                unicast_address=lambda caps: 0x0010 + caps["num_elements"], on_before_data=before)
            device = await device_task
            return result, device, journaled, net_key

        result, device, journaled, net_key = asyncio.run(scenario())
        self.assertEqual(result["device_key"], device["device_key"])
        self.assertEqual(journaled, [result["device_key"]])
        self.assertEqual(result["num_elements"], 2)
        data = device["provisioning_data"]
        self.assertEqual((data["net_key"], data["unicast_address"], data["iv_index"]), (net_key, 0x12, 7))

    def test_a_forged_confirmation_aborts_before_any_key_is_sent(self):
        async def scenario():
            pipe = Pipe()
            device = pipe.device_side()

            async def forging_device():
                # Répond avec une confirmation invalide.
                await device.receive(provisioning.INVITE)
                await device.send(provisioning.CAPABILITIES, bytes([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
                await device.receive(provisioning.START)
                await device.receive(provisioning.PUBLIC_KEY)
                from klixa_smallrig.crypto import generate_provisioning_key_pair
                await device.send(provisioning.PUBLIC_KEY, generate_provisioning_key_pair()[1])
                await device.receive(provisioning.CONFIRMATION)
                await device.send(provisioning.CONFIRMATION, bytes(16))
                await device.receive(provisioning.RANDOM)
                await device.send(provisioning.RANDOM, bytes(16))

            task = asyncio.ensure_future(forging_device())
            try:
                await provisioning.run_provisioning(transport=pipe.provisioner_side(), net_key=bytes(16),
                                                    unicast_address=2)
            finally:
                task.cancel()

        with self.assertRaises(ValueError) as caught:
            asyncio.run(scenario())
        self.assertFalse(caught.exception.provisioning_data_may_have_been_sent)

    def test_capabilities_validation(self):
        good = provisioning.decode_capabilities(bytes([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
        self.assertEqual(provisioning.validate_no_oob_capabilities(good)["num_elements"], 1)
        for bad in (bytes([0, 0, 1] + [0] * 8), bytes([1, 0, 0] + [0] * 8), bytes([1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0])):
            with self.assertRaises(ValueError):
                provisioning.validate_no_oob_capabilities(provisioning.decode_capabilities(bad))
        with self.assertRaises(ValueError):
            provisioning.decode_capabilities(b"\x00")


if __name__ == "__main__":
    unittest.main()
