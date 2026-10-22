"""Liaison matérielle Bluetooth LE via `bleak` (BlueZ sous Linux, WinRT sous Windows, CoreBluetooth sous macOS).

Seul module qui dépend d'un vrai adaptateur Bluetooth : tout le reste (crypto, couches mesh, provisioning,
orchestration) est testé sans matériel."""
import asyncio
import logging
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

log = logging.getLogger("smallrig.ble")

PROVISIONING_SERVICE, PROVISIONING_DATA_IN, PROVISIONING_DATA_OUT = 0x1827, 0x2ADB, 0x2ADC
PROXY_SERVICE, PROXY_DATA_IN, PROXY_DATA_OUT = 0x1828, 0x2ADD, 0x2ADE

# Taille utile par écriture GATT (MTU 23 - 3 octets d'en-tête ATT). Valeur conservatrice : la segmentation
# Proxy PDU absorbe la différence si le MTU réel est plus grand (juste plus de fragments que nécessaire).
DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 20
CONNECT_TIMEOUT_S = 20.0


class BleError(Exception):
    pass


def uuid_string(short_uuid):
    return f"0000{short_uuid:04x}-0000-1000-8000-00805f9b34fb"


@dataclass
class LampAdvertisement:
    ble_device_id: str
    kind: str  # 'provisioned' (Proxy 0x1828) | 'unprovisioned' (Provisioning 0x1827)
    device: Any = field(default=None, repr=False)
    network_id: Optional[bytes] = None  # 8 octets, seulement pour une annonce « Network ID »
    device_uuid: Optional[bytes] = None  # 16 octets, seulement pour une lampe non provisionnée
    rssi: Optional[int] = None
    name: Optional[str] = None


def parse_lamp_advertisement(device, service_data, rssi=None) -> Optional[LampAdvertisement]:
    """Lit les Service Data d'une annonce. Si une lampe a vu passer 0x1827 puis 0x1828 dans la même fenêtre,
    0x1828 est l'état le plus récent possible (le provisioning est à sens unique) et prime."""
    if not service_data:
        return None
    proxy = service_data.get(uuid_string(PROXY_SERVICE))
    if proxy and len(proxy) >= 1:
        proxy = bytes(proxy)
        is_network_id = proxy[0] == 0x00 and len(proxy) >= 9
        return LampAdvertisement(device.address, "provisioned", device, network_id=proxy[1:9] if is_network_id else None,
                                 rssi=rssi, name=device.name)
    provisioning = service_data.get(uuid_string(PROVISIONING_SERVICE))
    if provisioning and len(provisioning) >= 16:
        return LampAdvertisement(device.address, "unprovisioned", device, device_uuid=bytes(provisioning)[:16],
                                 rssi=rssi, name=device.name)
    return None


async def scan_for_lamp_advertisements(timeout_ms=6000, stop_when: Optional[Callable] = None) -> List[LampAdvertisement]:
    """Scanne les lampes RM75 à proximité (provisionnées ou non) en lisant les Service Data, sans se connecter.
    `stop_when(annonce)` vrai arrête le scan avant la fin de la fenêtre (qui n'est alors qu'un plafond)."""
    from bleak import BleakScanner

    found = {}
    stop = asyncio.Event()

    def on_detection(device, advertisement):
        lamp = parse_lamp_advertisement(device, advertisement.service_data, advertisement.rssi)
        if lamp is None:
            return
        previous = found.get(device.address)
        if previous and previous.kind == "provisioned" and lamp.kind == "unprovisioned":
            return
        found[device.address] = lamp
        if stop_when is not None:
            try:
                if stop_when(lamp):
                    stop.set()
            except Exception:  # noqa: BLE001 - prédicat best-effort : ne jamais casser le scan
                pass

    try:
        async with BleakScanner(detection_callback=on_detection):
            try:
                await asyncio.wait_for(stop.wait(), timeout=timeout_ms / 1000)
            except asyncio.TimeoutError:
                pass
    except Exception as error:  # noqa: BLE001
        raise BleError(f"Scan Bluetooth impossible : {error}") from error
    return list(found.values())


async def wait_for_proxy_advertisement(timeout_ms=5000, retry_delay_ms=500) -> List[LampAdvertisement]:
    """Après le Provisioning Complete la lampe passe de 0x1827 à 0x1828 : rescanne jusqu'à voir un Proxy."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_ms / 1000
    last_error = None
    while loop.time() < deadline:
        try:
            remaining_ms = (deadline - loop.time()) * 1000
            found = await scan_for_lamp_advertisements(timeout_ms=max(6000, min(8000, remaining_ms)))
            proxies = [lamp for lamp in found if lamp.kind == "provisioned"]
            if proxies:
                return proxies
        except BleError as error:
            last_error = error
        await asyncio.sleep(retry_delay_ms / 1000)
    if last_error:
        raise last_error
    raise BleError("Aucune lampe en mode Proxy détectée après provisioning")


class GattConnection:
    """Connexion GATT vers le service Provisioning ou Proxy, notifications actives sur Data Out."""

    def __init__(self, client, data_in, max_attribute_value_length):
        self._client = client
        self._data_in = data_in
        self.max_attribute_value_length = max_attribute_value_length
        self._closed = False

    @property
    def connected(self):
        return not self._closed and self._client.is_connected

    async def write(self, data):
        if self._closed:
            raise BleError("Connexion GATT fermée")
        await self._client.write_gatt_char(self._data_in, bytes(data), response=False)

    async def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            await self._client.disconnect()
        except Exception as error:  # noqa: BLE001
            log.warning("Erreur à la déconnexion GATT : %s", error)


def _is_device_gone(error):
    """BlueZ oublie les périphériques découverts par un scan terminé : l'objet D-Bus de la lampe peut avoir
    disparu entre le scan et la connexion (« device ... not found »)."""
    text = str(error).lower()
    return "not found" in text or "was not found" in text


async def _connect_while_scanning(device, address):
    """BlueZ : une connexion LE vers un appareil qui n'est plus en cache n'aboutit que si une découverte est
    active. On garde donc un scan en cours pendant `connect()` (et on repart de l'objet frais qu'il remonte)."""
    from bleak import BleakClient, BleakScanner

    seen = asyncio.Event()
    fresh = {"device": None}

    def on_detection(found, _advertisement):
        if found.address.upper() == address.upper():
            fresh["device"] = found
            seen.set()

    async with BleakScanner(detection_callback=on_detection):
        try:
            await asyncio.wait_for(seen.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            log.info("Périphérique %s non revu pendant le scan, tentative de connexion quand même", address)
        client = BleakClient(fresh["device"] or device, timeout=CONNECT_TIMEOUT_S)
        try:
            await client.connect()
        except BaseException:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            raise
        return client


async def _connect(device, attempts=3):
    """Connecte un client bleak (essais multiples ; sous Linux, scan actif pendant la connexion)."""
    from bleak import BleakClient, BleakScanner

    target = device.device if isinstance(device, LampAdvertisement) else device
    address = getattr(target, "address", None)
    linux = sys.platform.startswith("linux") and bool(address)
    attempts = 2 if linux else attempts
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            if linux:
                return await _connect_while_scanning(target, address)
            client = BleakClient(target, timeout=CONNECT_TIMEOUT_S)
            try:
                await client.connect()
                return client
            except BaseException:
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001
                    pass
                raise
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt == attempts or not address:
                break
            if linux:
                log.info("Connexion à %s échouée (%s), nouvel essai %d/%d", address, str(error) or type(error).__name__,
                         attempt + 1, attempts)
                continue
            if not _is_device_gone(error):
                break
            log.info("Périphérique %s oublié par BlueZ, nouveau scan ciblé (essai %d/%d)", address, attempt, attempts)
            fresh = await BleakScanner.find_device_by_address(address, timeout=10.0)
            if fresh is not None:
                target = fresh
    raise last_error


async def open_gatt_connection(device, *, service_uuid, data_in_uuid, data_out_uuid, on_data,
                               max_attribute_value_length=DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH) -> GattConnection:
    phase = "connexion au périphérique"
    client = None
    try:
        client = await _connect(device)
        phase = f"découverte du service 0x{service_uuid:04x}"
        service = client.services.get_service(uuid_string(service_uuid))
        if service is None:
            raise BleError("service GATT absent")
        data_in = service.get_characteristic(uuid_string(data_in_uuid))
        data_out = service.get_characteristic(uuid_string(data_out_uuid))
        if data_in is None or data_out is None:
            raise BleError("caractéristiques Data In/Out absentes")

        def on_notification(_sender, data):
            try:
                on_data(bytes(data))
            except Exception as error:  # noqa: BLE001 - une notification mal formée ne doit pas tout casser
                log.warning("Notification GATT SmallRig ignorée : %s", error)

        phase = "activation des notifications"
        await client.start_notify(data_out, on_notification)
    except Exception as error:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        detail = str(error) or type(error).__name__
        raise BleError(f"Ouverture GATT 0x{service_uuid:04x} échouée pendant {phase} : {detail}") from error
    return GattConnection(client, data_in, max_attribute_value_length)


async def open_provisioning_connection(device, on_data) -> GattConnection:
    return await open_gatt_connection(device, service_uuid=PROVISIONING_SERVICE, data_in_uuid=PROVISIONING_DATA_IN,
                                      data_out_uuid=PROVISIONING_DATA_OUT, on_data=on_data)


async def open_proxy_connection(device, on_data) -> GattConnection:
    return await open_gatt_connection(device, service_uuid=PROXY_SERVICE, data_in_uuid=PROXY_DATA_IN,
                                      data_out_uuid=PROXY_DATA_OUT, on_data=on_data)
