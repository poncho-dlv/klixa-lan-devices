"""SDK de référence pour piloter du matériel LAN (Raspberry Pi, ESP...) depuis Klixa,
via le compagnon Klixa Companion.

Le compagnon N'INITIE JAMAIS la connexion vers ce script : c'est CE script qui se
connecte AU compagnon (WS sortant, comme le compagnon lui-même se connecte au cloud
Klixa), s'annonce avec ses éléments pilotables (switch on/off, etc.), puis reçoit des
commandes. Protocole complet : klixa-companion/protocol/devices-messages.md.

Usage minimal (voir aussi smoke_relay.py, dans ce même dossier, pour un exemple réel
complet) :

    from klixa_device_agent import DeviceAgent

    agent = DeviceAgent(
        companion_url="ws://192.168.1.30:8786/devices/ws",
        token="kxd_...",
        device_id="smoke-machine",
        name="Machine à fumée",
    )

    @agent.action("relay", "trigger", params={"durationMs": {"min": 50, "max": 1500, "default": 300}})
    def trigger(payload, data):
        duration_ms = payload.get("durationMs", 300)
        # ... piloter le relais (gpiozero, RPi.GPIO...) ...
        return {"durationMs": duration_ms}

    agent.run()

Un handler peut être une fonction normale (bloquante — exécutée dans un thread pour ne
jamais geler la connexion WS, cf. _dispatch_command) ou une coroutine `async def`.
`data` est le champ JSON libre du protocole (jamais interprété par Klixa ni le
compagnon) : sa forme est entièrement à la discrétion de ce script.

Dépendance unique : `websockets` (cf. requirements.txt). Aucune autre lib tierce.
"""

import asyncio
import contextlib
import inspect
import json
import signal
import sys
import time

import websockets

PROTOCOL_VERSION = 1
# Les éléments de type « light » (agent.light(...)) demandent le protocole v2 du compagnon.
PROTOCOL_VERSION_LIGHT = 2


def _log(device_id, message):
    # Un print() préfixé, simple, capturé tel quel par journalctl quand le script
    # tourne en service systemd — pas besoin du module logging pour un script pensé
    # pour être lu/adapté par un streamer.
    print(f"[{device_id}] {message}", flush=True)


async def _connect(url, headers):
    """Compatibilité websockets >=13 (`additional_headers`) et <13 (`extra_headers`) —
    évite d'imposer une version précise à un script destiné à tourner sur un Raspberry
    Pi dont le pip peut être ancien."""
    try:
        return await websockets.connect(url, additional_headers=headers)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers)


class DeviceAgent:
    """Un agent = une connexion au compagnon, un catalogue d'éléments pilotables
    déclarés via `.action(...)`, et une boucle de reconnexion automatique."""

    def __init__(
        self,
        companion_url,
        token,
        device_id,
        name=None,
        reconnect_min_s=1.0,
        reconnect_max_s=30.0,
    ):
        self.companion_url = companion_url
        self.token = token
        self.device_id = device_id
        self.name = name or device_id
        self.reconnect_min_s = reconnect_min_s
        self.reconnect_max_s = reconnect_max_s

        self._elements = {}  # element_id -> {id, type, name, actions:[...], params:{...}}
        self._handlers = {}  # (element_id, action) -> callable(payload, data)
        self._stopping = False
        self._ws = None
        self._loop = None

    def action(self, element_id, action_name, *, element_type="switch", element_name=None, params=None):
        """Décorateur : déclare qu'`element_id` sait exécuter `action_name`, et branche
        la fonction décorée comme handler. Appeler plusieurs fois avec le même
        `element_id` (actions différentes) accumule sur le MÊME élément — inutile de
        déclarer l'élément séparément de ses actions.

        `params`, optionnel, sert uniquement à ce que Klixa construise un input admin
        typé et borné (ex. {"durationMs": {"min":50,"max":1500,"default":300}}) — ce
        script n'a rien d'autre à en faire, `payload` arrive déjà tel quel.
        """
        def decorator(func):
            element = self._elements.setdefault(element_id, {
                "id": element_id,
                "type": element_type,
                "name": element_name or element_id,
                "actions": [],
                "params": {},
            })
            if action_name not in element["actions"]:
                element["actions"].append(action_name)
            if params:
                element["params"][action_name] = params
            self._handlers[(element_id, action_name)] = func
            return func
        return decorator

    def light(self, element_id, *, name=None, capabilities=("onoff",), kelvin=None, fx_modes=None):
        """Déclare une LAMPE (élément de type « light », protocole v2) et renvoie un objet
        dont `.set` et `.get_state` sont des décorateurs.

        - `capabilities` : parmi "onoff", "dimming", "color", "color_temperature" — Klixa
          n'enverra que ce que la lampe sait porter ;
        - `kelvin` : (min, max) si la lampe a une température de blanc réglable ;
        - `fx_modes` : {"id": "Libellé"} des effets matériels proposés dans l'éditeur.

        Le handler `.set(state, data)` reçoit `{"on": bool, "color": "#RRGGBB"?, "brightness": 1-100?,
        "kelvin": int?, "fx": str?}`. `.get_state()` (facultatif) doit renvoyer le même format :
        c'est ce qui permet au compagnon de rendre à la lampe son état d'avant après un effet
        temporaire. Sans `get_state`, un effet temporaire reste appliqué.

            lamp = agent.light("lamp", name="Lampe bureau", capabilities=["onoff", "dimming", "color"])

            @lamp.set
            def set_lamp(state, data):
                ...

            @lamp.get_state
            def get_lamp():
                return {"on": True, "color": "#FFFFFF", "brightness": 100}
        """
        element = self._elements.setdefault(element_id, {
            "id": element_id,
            "type": "light",
            "name": name or element_id,
            "actions": [],
            "params": {},
        })
        element["type"] = "light"
        element["capabilities"] = list(capabilities)
        if kelvin:
            element["kelvin"] = {"min": int(kelvin[0]), "max": int(kelvin[1])}
        if fx_modes:
            element["fxModes"] = [{"id": key, "label": label} for key, label in fx_modes.items()]

        agent = self

        class _Light:
            def set(self, func):
                return agent.action(element_id, "set", element_type="light")(func)

            def get_state(self, func):
                # getState n'a ni payload ni donnée : le handler ne prend aucun argument (fonction ou coroutine).
                if inspect.iscoroutinefunction(func):
                    async def handler(payload, data):
                        return await func()
                else:
                    def handler(payload, data):
                        return func()
                agent.action(element_id, "getState", element_type="light")(handler)
                return func

        return _Light()

    def send_event(self, element_id, data):
        """Canal montant réservé du protocole (cf. devices-messages.md) : pas encore
        exploité côté Klixa aujourd'hui, mais utilisable dès maintenant (ex. un bouton
        physique) sans attendre une future évolution du protocole. Thread-safe :
        appelable depuis un handler synchrone qui tourne dans un thread d'exécuteur.
        """
        if self._loop is None:
            return
        message = {"type": "event", "elementId": element_id, "data": data}
        asyncio.run_coroutine_threadsafe(self._send(message), self._loop)

    async def _send(self, message):
        if self._ws is not None:
            await self._ws.send(json.dumps(message))

    async def _dispatch_command(self, message):
        command_id = message.get("id")
        element_id = message.get("elementId")
        action_name = message.get("action")
        payload = message.get("payload") or {}
        data = message.get("data") or {}

        handler = self._handlers.get((element_id, action_name))
        if handler is None:
            await self._send({
                "type": "ack", "id": command_id, "ok": False,
                "error": f"Aucun handler pour {element_id}.{action_name}",
            })
            return

        try:
            if inspect.iscoroutinefunction(handler):
                result = await handler(payload, data)
            else:
                # Handler bloquant (gpiozero, sleep...) : exécuté dans un thread pour ne
                # jamais geler la boucle asyncio (donc le heartbeat/la réception d'autres
                # commandes).
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, handler, payload, data)
            await self._send({"type": "ack", "id": command_id, "ok": True, "result": result or {}})
        except Exception as error:  # noqa: BLE001 - une erreur handler ne doit jamais crasher l'agent
            _log(self.device_id, f"Erreur handler {element_id}.{action_name} : {error}")
            await self._send({"type": "ack", "id": command_id, "ok": False, "error": str(error)})

    async def _run_once(self):
        headers = {"Authorization": f"Bearer {self.token}"}
        ws = await _connect(self.companion_url, headers)
        self._ws = ws
        try:
            await ws.send(json.dumps({
                "type": "hello",
                "protocolVersion": (
                    PROTOCOL_VERSION_LIGHT
                    if any(el["type"] == "light" for el in self._elements.values())
                    else PROTOCOL_VERSION
                ),
                "deviceId": self.device_id,
                "name": self.name,
                "elements": list(self._elements.values()),
            }))

            registered = json.loads(await ws.recv())
            if registered.get("type") != "registered" or not registered.get("ok"):
                _log(self.device_id, f"Enregistrement refusé : {registered.get('error', registered)}")
                return
            _log(self.device_id, "Connecté et enregistré auprès du compagnon.")

            pending_tasks = set()
            async for raw in ws:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get("type") != "command":
                    continue
                task = asyncio.create_task(self._dispatch_command(message))
                pending_tasks.add(task)
                task.add_done_callback(pending_tasks.discard)
        finally:
            self._ws = None

    async def _run_forever(self):
        self._loop = asyncio.get_running_loop()
        attempt = 0
        while not self._stopping:
            try:
                await self._run_once()
                attempt = 0  # une connexion qui a tenu un moment réinitialise le backoff
            except (websockets.exceptions.ConnectionClosed, OSError) as error:
                _log(self.device_id, f"Connexion perdue : {error}")
            except Exception as error:  # noqa: BLE001 - ne jamais arrêter l'agent sur une erreur inattendue
                _log(self.device_id, f"Erreur inattendue : {error}")

            if self._stopping:
                break
            attempt += 1
            delay = min(self.reconnect_max_s, self.reconnect_min_s * (2 ** (attempt - 1)))
            _log(self.device_id, f"Reconnexion dans {delay:.1f}s (tentative {attempt})")
            await asyncio.sleep(delay)

    def stop(self):
        """À appeler depuis la boucle de l'agent (signal handler, ou un handler `async
        def`) : ferme la connexion en cours pour interrompre _run_once() tout de suite,
        plutôt que d'attendre une coupure naturelle avant de constater l'arrêt demandé."""
        self._stopping = True
        if self._ws is not None:
            asyncio.ensure_future(self._ws.close())

    async def serve(self):
        """Variante asynchrone de `run()` pour un script qui possède déjà sa boucle asyncio : se connecte, se
        reconnecte, et s'arrête proprement sur SIGINT/SIGTERM."""
        loop = asyncio.get_running_loop()
        with contextlib.suppress(NotImplementedError):
            # add_signal_handler n'existe pas sur Windows — sans effet en dev,
            # KeyboardInterrupt reste géré normalement par asyncio.run().
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, self.stop)
        await self._run_forever()

    def run(self):
        """Point d'entrée bloquant — gère aussi l'arrêt propre sur Ctrl+C/SIGTERM
        (utile pour un service systemd, cf. rpi/klixa-smoke-relay.service)."""
        try:
            asyncio.run(self.serve())
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    print(__doc__, file=sys.stderr)
    sys.exit(1)
