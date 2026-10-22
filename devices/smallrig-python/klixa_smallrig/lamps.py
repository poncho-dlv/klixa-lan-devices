"""Contrôleur des lampes SmallRig RM75 : une instance = un état mesh (clés, nœuds, séquences) persisté.

Pilote UNE lampe à la fois (chaque lampe est un élément `light` de l'appareil LAN). Le maintien temporaire et la
restauration sont faits par le compagnon : ce contrôleur ne fournit que `set_state` et `get_state`."""
import logging

from .mesh_client import MeshClient
from .store import parse_mesh_state, serialize_mesh_state

log = logging.getLogger("smallrig")

DEFAULT_INTENSITY = 85
KELVIN_RANGE = {"min": 2500, "max": 10000}  # valeurs usuelles du blanc réglable RM75, non confirmées sur matériel
LAMP_CAPABILITIES = ("onoff", "dimming", "color", "color_temperature")

# Effets matériels RM75 (modes Lq 1-12) : l'id d'effet annoncé à Klixa est le numéro de mode.
FX_MODES = {
    "1": "Paparazzi (flash appareil photo)", "2": "Cycle de couleurs", "3": "Éclair", "4": "Pulsation (respiration)",
    "5": "SOS", "6": "Soudure", "7": "Alarme", "8": "Feu d’artifice", "9": "Aléatoire", "10": "Feu",
    "11": "Scintillement TV", "12": "Ampoule défectueuse",
}

# Lecture de snapshot : timeout court, best-effort (repli sur « allumée »).
_SNAPSHOT_READ = {"timeout_s": 1.2, "close_on_timeout": False}
_STATUS_READ = {"timeout_s": 12.0}


def is_hex_color(value):
    return isinstance(value, str) and len(value) == 7 and value[0] == "#" and all(
        c in "0123456789abcdefABCDEF" for c in value[1:])


def clamp(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def hex_to_hue_sat(hex_color):
    """#RRGGBB -> (teinte 0-360, saturation 0-100) : modèle HSI natif des RM75, l'intensité reste séparée."""
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    high, low = max(r, g, b), min(r, g, b)
    delta = high - low
    hue = 0.0
    if delta:
        if high == r:
            hue = 60 * (((g - b) / delta) % 6)
        elif high == g:
            hue = 60 * ((b - r) / delta + 2)
        else:
            hue = 60 * ((r - g) / delta + 4)
        if hue < 0:
            hue += 360
    sat = 0 if high == 0 else _round_half_up(delta / high * 100)
    return _round_half_up(hue), sat


def _round_half_up(value):
    return int(value + 0.5)


def _hex2(value):
    return f"{max(0, min(255, _round_half_up(value))):02x}"


def hue_sat_to_hex(hue, sat):
    """Teinte/saturation (0-360 / 0-100, valeur maximale) -> `#RRGGBB`. Inverse de hex_to_hue_sat."""
    s = max(0.0, min(100.0, float(sat or 0))) / 100
    h = (((float(hue or 0) % 360) + 360) % 360) / 60
    c = s
    x = c * (1 - abs((h % 2) - 1))
    m = 1 - c
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(h) % 6]
    return "#" + "".join(_hex2((channel + m) * 255) for channel in (r, g, b)).upper()


def merge_baseline(previous, patch):
    """Fusion d'un patch de baseline avec l'état précédent d'une lampe."""
    base = previous or {"status": None, "poweredOn": True}
    return {"status": patch["status"] if "status" in patch else base["status"],
            "poweredOn": patch["poweredOn"] if "poweredOn" in patch else base["poweredOn"]}


def baseline_to_payload(baseline):
    """État mémorisé -> charge utile `set` du protocole des appareils LAN, pour que le compagnon puisse restaurer
    l'état d'avant."""
    if not baseline or baseline.get("poweredOn") is False:
        return {"on": False} if baseline else {"on": True}
    status = baseline.get("status") or {}
    kind = status.get("type")
    if kind == "hsi":
        return {"on": True, "color": status.get("hex") or hue_sat_to_hex(status["hue"], status["sat"]),
                "brightness": status["intensity"]}
    if kind == "cct":
        return {"on": True, "kelvin": status["kelvin"], "brightness": status["intensity"]}
    if kind == "rgbw":
        return {"on": True, "color": "#" + "".join(_hex2(status[c]) for c in ("r", "g", "b")).upper()}
    if kind == "fx":
        return {"on": True, "fx": str(status["mode"])}
    return {"on": True}


class LampCommandError(Exception):
    code = "SMALLRIG_COMMAND_FAILED"


def assert_light_command_results(command, uuid, batches):
    results = [r for batch in batches for r in (batch if isinstance(batch, list) else [batch]) if r]
    failures = [r for r in results if r.get("ok") is not True]
    if failures or not results:
        details = "; ".join(f.get("error") or "échec inconnu" for f in failures) or "aucun résultat"
        raise LampCommandError(f"{command} incomplète ({uuid}: {details})")
    return results


class LampController:
    def __init__(self, *, mesh_state_json="", on_state_change=None, max_lamps=50, seq_block_size=100, ble=None):
        self._max_lamps = max(1, min(200, int(max_lamps) or 50))
        self._on_state_change = on_state_change
        self._state = parse_mesh_state(mesh_state_json)
        self._persistence_failure = None
        # Dernier état ÉCRIT par ce script, par lampe : sert de snapshot de restauration sans aller-retour BLE
        # (la lecture mesh ne subsiste qu'en repli, une fois par lampe et par session). Compromis assumé : un
        # état changé hors de ce script (app SmallGoGo, boutons) n'est pas vu.
        self._baselines = {}

        if ble is None:
            from . import ble as ble_module
            ble = ble_module
        self.client = MeshClient(
            get_state=self._get_state, persist_state=self._persist_state,
            scan_for_lamp_advertisements=ble.scan_for_lamp_advertisements,
            open_provisioning_connection=ble.open_provisioning_connection,
            open_proxy_connection=ble.open_proxy_connection,
            wait_for_proxy_advertisement=ble.wait_for_proxy_advertisement,
            seq_block_size=max(10, int(seq_block_size) or 100))

    def _get_state(self):
        if self._persistence_failure:
            raise self._persistence_failure
        return self._state

    async def _persist_state(self, next_state):
        if self._on_state_change:
            try:
                await self._on_state_change(serialize_mesh_state(next_state))
            except Exception as error:
                failure = LampCommandError(f"Échec de la persistance de l’état Mesh SmallRig : {error}")
                failure.code = "SMALLRIG_STATE_PERSIST_FAILED"
                self._persistence_failure = failure
                log.error("%s", failure)
                raise failure from error
        self._state = next_state
        self._persistence_failure = None

    def _assert_known(self, uuid):
        if not any(node["uuid"] == uuid for node in self.client.list_nodes()):
            raise LampCommandError("Lampe inconnue (uuid non trouvé parmi les lampes provisionnées)")

    async def _execute(self, command, uuid, operation, baseline_patch=None):
        assert_light_command_results(command, uuid, [await operation()])
        if baseline_patch:
            self._baselines[uuid] = merge_baseline(self._baselines.get(uuid), baseline_patch)

    async def set_state(self, uuid, wanted=None):
        """Applique un état (`{on, color, brightness, kelvin, fx}`, format de l'élément `light`)."""
        wanted = wanted or {}
        self._assert_known(uuid)

        if wanted.get("on") is False:
            await self._execute("Extinction", uuid, lambda: self.client.set_power([uuid], on=False),
                                {"poweredOn": False})
            return {"applied": True}

        intensity = clamp(wanted.get("brightness"), 1, 100, DEFAULT_INTENSITY)
        fx = wanted.get("fx")
        kelvin = wanted.get("kelvin")

        if fx not in (None, ""):
            try:
                mode = int(float(fx))
            except (TypeError, ValueError):
                mode = 0
            if not 1 <= mode <= 12:
                raise LampCommandError(f"Effet inconnu : {fx}")
            await self._execute("Effet dynamique", uuid, lambda: self.client.set_fx([uuid], mode, 0, 0),
                                {"status": {"type": "fx", "mode": mode, "freq": 0, "intensity": 0}, "poweredOn": True})
        elif is_hex_color(wanted.get("color")):
            color = wanted["color"].upper()
            hue, sat = hex_to_hue_sat(color)
            await self._execute("Commande couleur", uuid, lambda: self.client.set_hsi([uuid], hue, sat, intensity),
                                {"status": {"type": "hsi", "hue": hue, "sat": sat, "intensity": intensity,
                                            "hex": color}, "poweredOn": True})
        elif kelvin is not None and clamp(kelvin, float("-inf"), float("inf"), None) is not None:
            value = _round_half_up(clamp(kelvin, KELVIN_RANGE["min"], KELVIN_RANGE["max"], 5600))
            await self._execute("Commande température", uuid, lambda: self.client.set_cct([uuid], value, intensity, 0),
                                {"status": {"type": "cct", "kelvin": value, "intensity": intensity, "gm": 0},
                                 "poweredOn": True})
        else:
            brightness = wanted.get("brightness")
            level = None if brightness is None else clamp(brightness, 0, 100, None)
            await self._execute("Allumage", uuid, lambda: self.client.set_power([uuid], on=True, level=level),
                                {"poweredOn": True})
        return {"applied": True}

    async def get_state(self, uuid):
        """État courant au format `set` : baseline logicielle, sinon lecture mesh best-effort, sinon « allumée »."""
        self._assert_known(uuid)
        baseline = self._baselines.get(uuid)
        if baseline is None:
            status = capacity = None
            try:
                status = await self.client.read_status(uuid, **_SNAPSHOT_READ)
            except Exception:  # noqa: BLE001 - best-effort
                pass
            try:
                capacity = await self.client.read_capacity(uuid, **_SNAPSHOT_READ)
            except Exception:  # noqa: BLE001
                pass
            baseline = {"status": status, "poweredOn": capacity["powered_on"] if capacity else None}
            self._baselines[uuid] = baseline
        return baseline_to_payload(baseline)

    async def status(self, uuid):
        self._assert_known(uuid)
        try:
            state = await self.client.read_status(uuid, **_STATUS_READ)
        except Exception as error:  # noqa: BLE001
            state = {"error": str(error)}
        try:
            capacity = await self.client.read_capacity(uuid, **_STATUS_READ)
        except Exception as error:  # noqa: BLE001
            capacity = {"error": str(error)}
        return {"state": state, "capacity": capacity}

    async def provision(self, ble_device_id=None, device_uuid=None, name=None):
        if not ble_device_id:
            raise LampCommandError("ble_device_id manquant (relancez la découverte)")
        normalized = (device_uuid or "").strip().lower() or None
        if normalized and (len(normalized) != 32 or any(c not in "0123456789abcdef" for c in normalized)):
            raise LampCommandError("deviceUuid SmallRig invalide")
        replaces = bool(normalized and any(node["uuid"] == normalized for node in self._state["nodes"]))
        if len(self._state["nodes"]) >= self._max_lamps and not replaces:
            raise LampCommandError(f"Nombre maximum de lampes atteint ({self._max_lamps})")
        result = await self.client.provision(ble_device_id=ble_device_id, device_uuid=normalized,
                                             name=name.strip()[:128] if name else None)
        if result.get("configured") is False:
            log.warning("Lampe provisionnée mais configuration en attente : %s", result)
        return result

    async def reconfigure(self, uuid):
        node = next((n for n in self._state["nodes"] if n["uuid"] == uuid), None)
        if not node:
            raise LampCommandError("Lampe inconnue (uuid non trouvé parmi les lampes provisionnées)")
        await self.client.configure_node(node)
        return {"uuid": uuid, "name": node["name"], "unicast_address": node["unicastAddress"]}

    async def forget(self, uuid, force_local=False):
        result = await self.client.forget(uuid, force_local)
        if result.get("removed"):
            self._baselines.pop(uuid, None)
        return result

    def list(self):
        return self.client.list_nodes()

    async def discover(self, timeout_ms=6000):
        return await self.client.discover(int(clamp(timeout_ms, 1000, 20000, 6000)))

    async def stop(self):
        await self.client.stop()
