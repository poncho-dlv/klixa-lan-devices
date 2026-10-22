#!/usr/bin/env python3
"""Machine à fumée — un relais électronique piloté par Klixa via le compagnon.

Le Raspberry Pi ferme un relais (GPIO) pendant une durée BORNÉE : l'impulsion fait partir la machine
à fumée. Klixa la déclenche depuis la console, une automatisation (follow, raid, récompense…) ou une
commande de chat. Le script se connecte AU compagnon (WebSocket sortant, aucun port à ouvrir sur le Pi).

Variables d'environnement (voir .env.example) :
  COMPANION_URL   ws://<ip-du-compagnon>:8786/devices/ws
  DEVICE_TOKEN    token généré dans l'app Klixa Companion (page « Appareils LAN »)
  DEVICE_ID       DOIT correspondre à l'identifiant choisi à la génération du token
  DEVICE_NAME     nom affiché côté Klixa (optionnel)
  SMOKE_GPIO_PIN  broche BCM du relais (défaut 17)
  SMOKE_MIN_MS, SMOKE_MAX_MS, SMOKE_DEFAULT_MS   bornes de la durée d'impulsion

Garde-fous : la durée est toujours bornée, une seule impulsion à la fois (une commande reçue pendant
une impulsion échoue clairement), et le relais retombe à « off » dans un `finally`.
"""
import os
import threading
from time import sleep

ELEMENT_ID = "relay"
ACTION = "trigger"


class SmokeRelay:
    """Logique de l'impulsion, indépendante du matériel (`relay` = tout objet avec on()/off())."""

    def __init__(self, relay, min_ms=50, max_ms=1500, default_ms=300, sleeper=sleep):
        self.relay = relay
        self.min_ms = min_ms
        self.max_ms = max_ms
        self.default_ms = default_ms
        self._sleep = sleeper
        # Une seule impulsion à la fois (rejet si occupé) : jamais de relais bloqué sur « on » à cause
        # de commandes qui se chevauchent.
        self._lock = threading.Lock()

    def clamp_ms(self, value):
        try:
            ms = int(value)
        except (TypeError, ValueError):
            ms = self.default_ms
        return max(self.min_ms, min(self.max_ms, ms))

    def trigger(self, payload, data):
        duration_ms = self.clamp_ms((payload or {}).get("durationMs"))
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("Impulsion déjà en cours")
        try:
            self.relay.on()
            self._sleep(duration_ms / 1000.0)
        finally:
            self.relay.off()
            self._lock.release()
        return {"durationMs": duration_ms}


def main():
    # Imports ici : ce fichier reste importable (tests) sans gpiozero ni websockets.
    from gpiozero import OutputDevice
    from klixa_device_agent import DeviceAgent

    pin = int(os.environ.get("SMOKE_GPIO_PIN", "17"))
    min_ms = int(os.environ.get("SMOKE_MIN_MS", "50"))
    max_ms = int(os.environ.get("SMOKE_MAX_MS", "1500"))
    default_ms = int(os.environ.get("SMOKE_DEFAULT_MS", "300"))

    smoke = SmokeRelay(OutputDevice(pin, active_high=True, initial_value=False), min_ms, max_ms, default_ms)

    agent = DeviceAgent(
        companion_url=os.environ["COMPANION_URL"],
        token=os.environ["DEVICE_TOKEN"],
        device_id=os.environ.get("DEVICE_ID", "smoke-machine"),
        name=os.environ.get("DEVICE_NAME", "Machine à fumée"),
    )
    agent.action(
        ELEMENT_ID, ACTION,
        element_name="Relais fumée",
        params={"durationMs": {"min": min_ms, "max": max_ms, "default": default_ms}},
    )(smoke.trigger)
    agent.run()


if __name__ == "__main__":
    main()
