import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from smoke_relay import SmokeRelay  # noqa: E402


class FakeRelay:
    def __init__(self):
        self.events = []

    def on(self):
        self.events.append("on")

    def off(self):
        self.events.append("off")


class SmokeRelayTest(unittest.TestCase):
    def make(self, **kwargs):
        relay = FakeRelay()
        sleeps = []
        smoke = SmokeRelay(relay, sleeper=sleeps.append, **kwargs)
        return smoke, relay, sleeps

    def test_clamp_borne_la_duree_et_retombe_sur_le_defaut(self):
        smoke, _, _ = self.make(min_ms=50, max_ms=1500, default_ms=300)
        self.assertEqual(smoke.clamp_ms(10), 50)
        self.assertEqual(smoke.clamp_ms(99999), 1500)
        self.assertEqual(smoke.clamp_ms("700"), 700)
        self.assertEqual(smoke.clamp_ms(None), 300)
        self.assertEqual(smoke.clamp_ms("n'importe quoi"), 300)

    def test_impulsion_ferme_puis_ouvre_le_relais(self):
        smoke, relay, sleeps = self.make()
        result = smoke.trigger({"durationMs": 400}, {})
        self.assertEqual(result, {"durationMs": 400})
        self.assertEqual(relay.events, ["on", "off"])
        self.assertEqual(sleeps, [0.4])

    def test_sans_parametre_la_duree_par_defaut_s_applique(self):
        smoke, _, sleeps = self.make(default_ms=300)
        self.assertEqual(smoke.trigger({}, {}), {"durationMs": 300})
        self.assertEqual(smoke.trigger(None, {}), {"durationMs": 300})
        self.assertEqual(sleeps, [0.3, 0.3])

    def test_le_relais_retombe_meme_si_l_impulsion_echoue(self):
        relay = FakeRelay()

        def broken_sleep(_seconds):
            raise OSError("interrompu")

        smoke = SmokeRelay(relay, sleeper=broken_sleep)
        with self.assertRaises(OSError):
            smoke.trigger({"durationMs": 100}, {})
        self.assertEqual(relay.events, ["on", "off"])
        # et le verrou est libéré : l'impulsion suivante n'est pas bloquée
        smoke._sleep = lambda _seconds: None
        self.assertEqual(smoke.trigger({"durationMs": 100}, {}), {"durationMs": 100})

    def test_une_impulsion_pendant_une_autre_est_refusee(self):
        relay = FakeRelay()
        started = threading.Event()
        release = threading.Event()

        def slow_sleep(_seconds):
            started.set()
            release.wait(timeout=2)

        smoke = SmokeRelay(relay, sleeper=slow_sleep)
        first = threading.Thread(target=smoke.trigger, args=({"durationMs": 500}, {}))
        first.start()
        self.assertTrue(started.wait(timeout=2))

        with self.assertRaisesRegex(RuntimeError, "déjà en cours"):
            smoke.trigger({"durationMs": 500}, {})

        release.set()
        first.join(timeout=2)
        # La deuxième tentative refusée n'a jamais touché au relais.
        self.assertEqual(relay.events, ["on", "off"])


if __name__ == "__main__":
    unittest.main()
