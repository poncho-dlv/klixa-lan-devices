"""Tests du SDK Python : protocole des appareils LAN contre un faux compagnon (serveur WebSocket local)."""
import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402

from klixa_device_agent import PROTOCOL_VERSION, PROTOCOL_VERSION_LIGHT, DeviceAgent  # noqa: E402


class Companion:
    """Faux compagnon : accepte une connexion, reçoit le hello, envoie des commandes, collecte les acks."""

    def __init__(self, commands):
        self.commands = commands
        self.hello = None
        self.acks = []
        self.headers = None

    async def handler(self, ws, *_):
        self.headers = getattr(getattr(ws, "request", None), "headers", None)
        self.hello = json.loads(await ws.recv())
        await ws.send(json.dumps({"type": "registered", "ok": True}))
        for command in self.commands:
            await ws.send(json.dumps({"type": "command", **command}))
        for _ in self.commands:
            self.acks.append(json.loads(await ws.recv()))
        await ws.close()


async def run_agent_against(agent, commands):
    companion = Companion(commands)
    async with websockets.serve(companion.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        agent.companion_url = f"ws://127.0.0.1:{port}/devices/ws"
        await asyncio.wait_for(agent._run_once(), timeout=5)
    return companion


class AgentTest(unittest.TestCase):
    def test_hello_en_protocole_1_pour_un_element_simple_et_ack_du_handler(self):
        agent = DeviceAgent("ws://x", "kxd_t", "smoke", name="Fumée")

        @agent.action("relay", "trigger", params={"durationMs": {"min": 50, "max": 1500, "default": 300}})
        def trigger(payload, data):
            return {"durationMs": payload.get("durationMs", 300)}

        companion = asyncio.run(run_agent_against(agent, [
            {"id": "c1", "elementId": "relay", "action": "trigger", "payload": {"durationMs": 200}, "data": {}}
        ]))

        self.assertEqual(companion.hello["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(companion.hello["deviceId"], "smoke")
        self.assertEqual(companion.hello["elements"][0]["id"], "relay")
        self.assertEqual(companion.hello["elements"][0]["actions"], ["trigger"])
        self.assertEqual(companion.acks, [{"type": "ack", "id": "c1", "ok": True, "result": {"durationMs": 200}}])
        if companion.headers is not None:
            self.assertEqual(companion.headers.get("Authorization"), "Bearer kxd_t")

    def test_une_lampe_annonce_le_protocole_2_et_ses_capacites(self):
        agent = DeviceAgent("ws://x", "t", "lamp-1")
        lamp = agent.light("strip", name="Ruban", capabilities=["onoff", "dimming", "color"], kelvin=(2000, 6500),
                           fx_modes={"rainbow": "Arc-en-ciel"})
        state = {"on": False}

        @lamp.set
        def set_strip(new_state, data):
            state.update(new_state)
            return {}

        @lamp.get_state
        def get_strip():
            return dict(state)

        companion = asyncio.run(run_agent_against(agent, [
            {"id": "c1", "elementId": "strip", "action": "set", "payload": {"on": True, "color": "#FF0000"}, "data": {}},
            {"id": "c2", "elementId": "strip", "action": "getState", "payload": {}, "data": {}},
        ]))

        element = companion.hello["elements"][0]
        self.assertEqual(companion.hello["protocolVersion"], PROTOCOL_VERSION_LIGHT)
        self.assertEqual(element["type"], "light")
        self.assertEqual(element["actions"], ["set", "getState"])
        self.assertEqual(element["capabilities"], ["onoff", "dimming", "color"])
        self.assertEqual(element["kelvin"], {"min": 2000, "max": 6500})
        self.assertEqual(element["fxModes"], [{"id": "rainbow", "label": "Arc-en-ciel"}])
        self.assertEqual(companion.acks[1]["result"], {"on": True, "color": "#FF0000"})

    def test_les_handlers_d_une_lampe_peuvent_etre_des_coroutines(self):
        agent = DeviceAgent("ws://x", "t", "lamp-1")
        lamp = agent.light("strip", capabilities=["onoff"])
        state = {"on": False}

        @lamp.set
        async def set_strip(new_state, data):
            state.update(new_state)
            return {"applied": True}

        @lamp.get_state
        async def get_strip():
            return dict(state)

        companion = asyncio.run(run_agent_against(agent, [
            {"id": "c1", "elementId": "strip", "action": "set", "payload": {"on": True}, "data": {}},
            {"id": "c2", "elementId": "strip", "action": "getState", "payload": {}, "data": {}},
        ]))

        self.assertEqual(companion.acks[0]["result"], {"applied": True})
        self.assertEqual(companion.acks[1], {"type": "ack", "id": "c2", "ok": True, "result": {"on": True}})

    def test_une_exception_du_handler_devient_un_ack_en_echec(self):
        agent = DeviceAgent("ws://x", "t", "d")

        @agent.action("relay", "trigger")
        def trigger(payload, data):
            raise RuntimeError("Impulsion déjà en cours")

        companion = asyncio.run(run_agent_against(agent, [
            {"id": "c1", "elementId": "relay", "action": "trigger", "payload": {}, "data": {}}
        ]))
        self.assertEqual(companion.acks[0]["ok"], False)
        self.assertIn("déjà en cours", companion.acks[0]["error"])

    def test_commande_inconnue_acquittee_en_echec(self):
        agent = DeviceAgent("ws://x", "t", "d")

        @agent.action("relay", "trigger")
        def trigger(payload, data):
            return {}

        companion = asyncio.run(run_agent_against(agent, [
            {"id": "c1", "elementId": "autre", "action": "x", "payload": {}, "data": {}}
        ]))
        self.assertEqual(companion.acks[0]["ok"], False)


if __name__ == "__main__":
    unittest.main()
