"""Lampes SmallRig RM75 (Bluetooth Mesh) exposées à Klixa comme un appareil LAN.

    python -m klixa_smallrig run                      expose les lampes appairées au compagnon (service)
    python -m klixa_smallrig scan                     liste les lampes à portée
    python -m klixa_smallrig pair [--index N] [--name Nom]   appaire une lampe détectée
    python -m klixa_smallrig list                     lampes appairées
    python -m klixa_smallrig reconfigure <uuid>       relance la configuration d'une lampe déjà appairée
    python -m klixa_smallrig forget <uuid> [--force]  oublie une lampe (--force : sans la réinitialiser)
    python -m klixa_smallrig status <uuid>            état et batterie d'une lampe
    python -m klixa_smallrig set <uuid> [--color #RRGGBB] [--brightness 1-100] [--kelvin K] [--fx 1-12] [--off]
                                                      envoie une commande à une lampe (test)

Option globale : -v / --verbose (journal détaillé des trames mesh).

Un seul processus doit utiliser l'état mesh à la fois : arrêtez `run` avant d'appairer ou d'oublier."""
import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from .agent import build_agent
from .config import load_config, load_dotenv
from .lamps import LampController, keep_connected
from .state_file import load_persisted_state, make_state_writer

log = logging.getLogger("smallrig.cli")


def create_lamps(config):
    state_file = Path(config.mesh_state_file).resolve()
    return LampController(mesh_state_json=load_persisted_state(state_file), on_state_change=make_state_writer(state_file),
                          max_lamps=config.max_lamps, seq_block_size=config.seq_block_size)


def build_parser():
    parser = argparse.ArgumentParser(prog="klixa_smallrig", description="Lampes SmallRig RM75 pour Klixa")
    parser.add_argument("-v", "--verbose", action="store_true", help="journal détaillé des trames mesh")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run")
    scan = sub.add_parser("scan")
    scan.add_argument("--timeout", type=float, default=8.0, help="durée du scan en secondes")
    pair = sub.add_parser("pair")
    pair.add_argument("--index", type=int)
    pair.add_argument("--name")
    pair.add_argument("--timeout", type=float, default=8.0)
    sub.add_parser("list")
    for name in ("reconfigure", "status"):
        sub.add_parser(name).add_argument("uuid")
    send = sub.add_parser("set")
    send.add_argument("uuid")
    send.add_argument("--color", help="#RRGGBB")
    send.add_argument("--brightness", type=float)
    send.add_argument("--kelvin", type=float)
    send.add_argument("--fx", help="numéro d'effet 1-12")
    send.add_argument("--off", action="store_true")
    forget = sub.add_parser("forget")
    forget.add_argument("uuid")
    forget.add_argument("--force", action="store_true")
    return parser


async def run(config):
    if not config.device_token:
        raise RuntimeError("DEVICE_TOKEN manquant (à générer dans Klixa Companion → Appareils LAN)")
    lamps = create_lamps(config)
    agent = build_agent(config, lamps)
    log.info("%d lampe(s) appairée(s), état mesh : %s", len(lamps.list()), Path(config.mesh_state_file).resolve())
    keeper = asyncio.ensure_future(keep_connected(lamps)) if config.keep_connected else None
    try:
        await agent.serve()
    finally:
        if keeper:
            keeper.cancel()
            await asyncio.gather(keeper, return_exceptions=True)
        await lamps.stop()


async def run_command(args, config):
    if args.command in (None, "run"):
        return await run(config)

    lamps = create_lamps(config)
    try:
        if args.command == "list":
            for lamp in lamps.list():
                print(f"{lamp['uuid']}  {lamp['name'] or ''}  [{lamp['configuration_status']}]")
        elif args.command == "scan":
            found = await lamps.discover(int(args.timeout * 1000))
            for index, lamp in enumerate(found):
                where = lamp.get("device_uuid") or lamp["ble_device_id"]
                suffix = " (réseau actuel)" if lamp.get("ours") else ""
                print(f"{index}  {lamp['kind']}{suffix}  {lamp['name'] or ''}  rssi {lamp['rssi']}  {where}")
            if not found:
                print("Aucune lampe détectée.")
        elif args.command == "pair":
            found = [lamp for lamp in await lamps.discover(int(args.timeout * 1000)) if lamp["kind"] == "unprovisioned"]
            if not found:
                raise RuntimeError("Aucune lampe à appairer détectée (réinitialisez la lampe puis relancez).")
            if args.index is not None:
                target = found[args.index]
            elif len(found) == 1:
                target = found[0]
            else:
                for index, lamp in enumerate(found):
                    print(f"{index}  {lamp['name'] or ''}  rssi {lamp['rssi']}  {lamp['device_uuid']}")
                raise RuntimeError("Plusieurs lampes détectées : choisissez avec --index N.")
            result = await lamps.provision(ble_device_id=target["ble_device_id"], device_uuid=target["device_uuid"],
                                           name=args.name)
            print(f"Lampe appairée : {json.dumps(result, ensure_ascii=False)}")
        elif args.command == "reconfigure":
            print(json.dumps(await lamps.reconfigure(args.uuid), ensure_ascii=False))
        elif args.command == "forget":
            print(json.dumps(await lamps.forget(args.uuid, force_local=args.force), ensure_ascii=False))
        elif args.command == "set":
            state = {"on": not args.off}
            for key in ("color", "brightness", "kelvin", "fx"):
                if getattr(args, key) is not None:
                    state[key] = getattr(args, key)
            print(json.dumps(await lamps.set_state(args.uuid, state), ensure_ascii=False))
        elif args.command == "status":
            print(json.dumps(await lamps.status(args.uuid), indent=2, ensure_ascii=False))
    finally:
        await lamps.stop()


def main(argv=None):
    load_dotenv()
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="[%(name)s] %(message)s")
    try:
        asyncio.run(run_command(args, load_config()))
    except KeyboardInterrupt:
        pass
    except Exception as error:  # noqa: BLE001
        print(str(error) or type(error).__name__, file=sys.stderr)
        return 1
    return 0
