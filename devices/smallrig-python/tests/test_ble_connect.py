"""Connexion GATT avec un `bleak` simulé : BlueZ oublie parfois l'appareil entre le scan et la connexion."""
import asyncio
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from klixa_smallrig import ble  # noqa: E402


class FakeBleak:
    """Installe un faux module `bleak` pour la durée d'un test."""

    def __init__(self, connect_failures):
        self.connect_failures = list(connect_failures)
        self.connect_calls = []
        self.scans = []
        self.scanner_active = False
        self.active_during_connect = []
        self.address = "70:3E:97:CD:A7:59"
        fake = self
        data_in = SimpleNamespace(uuid=ble.uuid_string(ble.PROXY_DATA_IN))
        data_out = SimpleNamespace(uuid=ble.uuid_string(ble.PROXY_DATA_OUT))
        service = SimpleNamespace(get_characteristic=lambda uuid: {data_in.uuid: data_in, data_out.uuid: data_out}.get(uuid))

        class BleakClient:
            def __init__(self, target, timeout=None):
                self.target = target
                self.is_connected = False
                self.services = SimpleNamespace(get_service=lambda uuid: service)

            async def connect(self):
                fake.connect_calls.append(self.target)
                fake.active_during_connect.append(fake.scanner_active)
                if fake.connect_failures:
                    raise fake.connect_failures.pop(0)
                self.is_connected = True

            async def start_notify(self, characteristic, callback):
                pass

            async def disconnect(self):
                self.is_connected = False

        class BleakScanner:
            def __init__(self, detection_callback=None):
                self.callback = detection_callback

            async def __aenter__(self):
                fake.scanner_active = True
                if self.callback:
                    asyncio.get_running_loop().call_soon(
                        self.callback, SimpleNamespace(address=fake.address, name="scanné"), None)
                return self

            async def __aexit__(self, *exc):
                fake.scanner_active = False

            @staticmethod
            async def find_device_by_address(address, timeout=10.0):
                fake.scans.append(address)
                return SimpleNamespace(address=address, name="frais")

        self.module = types.ModuleType("bleak")
        self.module.BleakClient, self.module.BleakScanner = BleakClient, BleakScanner

    def __enter__(self):
        self.previous = sys.modules.get("bleak")
        sys.modules["bleak"] = self.module
        return self

    def __exit__(self, *exc):
        if self.previous is not None:
            sys.modules["bleak"] = self.previous
        else:
            del sys.modules["bleak"]


def open_proxy(device):
    return asyncio.run(ble.open_proxy_connection(device, lambda data: None))


def on_platform(name):
    return patch.object(ble.sys, "platform", name)


class ConnectTests(unittest.TestCase):
    device = SimpleNamespace(address="70:3E:97:CD:A7:59", name="vieux")

    def test_a_device_forgotten_by_bluez_is_rescanned_then_connected(self):
        gone = Exception("device 'dev_70_3E_97_CD_A7_59' not found")
        with FakeBleak([gone]) as fake, on_platform("win32"):
            conn = open_proxy(ble.LampAdvertisement(self.device.address, "provisioned", self.device))
        self.assertEqual(fake.scans, [self.device.address])
        self.assertEqual([t.name for t in fake.connect_calls], ["vieux", "frais"])
        self.assertTrue(conn.max_attribute_value_length >= 20)

    def test_other_errors_are_not_retried(self):
        with FakeBleak([TimeoutError()]) as fake, on_platform("win32"):
            with self.assertRaises(ble.BleError) as caught:
                open_proxy(self.device)
        self.assertEqual((len(fake.connect_calls), fake.scans), (1, []))
        self.assertIn("TimeoutError", str(caught.exception))  # le message n'est jamais vide

    def test_gives_up_after_three_attempts(self):
        gone = Exception("device not found")
        with FakeBleak([gone, gone, gone]) as fake, on_platform("win32"):
            with self.assertRaises(ble.BleError):
                open_proxy(self.device)
        self.assertEqual(len(fake.connect_calls), 3)

    def test_linux_keeps_a_scan_running_during_the_connection_and_uses_the_fresh_device(self):
        with FakeBleak([]) as fake, on_platform("linux"):
            open_proxy(self.device)
        self.assertEqual(fake.active_during_connect, [True])
        self.assertEqual([t.name for t in fake.connect_calls], ["scanné"])
        self.assertFalse(fake.scanner_active)  # scan arrêté une fois connecté

    def test_linux_retries_once_after_a_timeout(self):
        with FakeBleak([TimeoutError()]) as fake, on_platform("linux"):
            open_proxy(self.device)
        self.assertEqual(fake.active_during_connect, [True, True])

    def test_linux_gives_up_after_two_attempts(self):
        with FakeBleak([TimeoutError(), TimeoutError()]) as fake, on_platform("linux"):
            with self.assertRaises(ble.BleError):
                open_proxy(self.device)
        self.assertEqual(len(fake.connect_calls), 2)


if __name__ == "__main__":
    unittest.main()
