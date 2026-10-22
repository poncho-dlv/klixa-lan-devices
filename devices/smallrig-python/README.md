# SmallRig RM75 — lampes Bluetooth Mesh (version Python)

Lampes **SmallRig RM75** (Bluetooth Mesh) exposées à Klixa comme un **appareil LAN**, en **Python**.

C'est le portage de [`devices/smallrig`](../smallrig) (Node.js, conservé) : mêmes couches (crypto mesh, réseau,
transport, provisioning, protocole Lq des lampes), même format de fichier d'état, même comportement côté Klixa.
Seule la liaison Bluetooth change : `bleak` (BlueZ sur Raspberry Pi) à la place de `webbluetooth` + correctif GATT
Windows, et le SDK Python [`klixa_device_agent.py`](../../sdk/python) pour parler au compagnon.

```
Klixa (cloud) ⇄ Klixa Companion ⇄ ce script ⇄ (Bluetooth Mesh) ⇄ lampes RM75
```

> **Statut :** les couches du protocole sont vérifiées **octet pour octet** contre l'implémentation Node.js et contre
> les vecteurs de la spécification Bluetooth Mesh ; provisioning, configuration, commandes, segmentation et
> Segment Ack sont testés de bout en bout contre un firmware simulé. En revanche, le script **n'a pas été validé
> sur une lampe réelle** (ni la version Node, ni celle-ci) : la plage de température (2500–10000 K) est une valeur
> usuelle non confirmée.

## Prérequis

- Python ≥ 3.9 et un adaptateur Bluetooth LE actif, sur la machine à portée des lampes (souvent un Raspberry Pi).
- Sous Linux : BlueZ (`bluetoothd` actif).

## Installation (Raspberry Pi OS)

```bash
sudo apt update && sudo apt install -y git bluez python3-venv
git clone https://github.com/poncho-dlv/klixa-lan-devices.git
cd klixa-lan-devices/devices/smallrig-python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env     # puis renseigner COMPANION_URL et DEVICE_TOKEN
```

Dans l'app **Klixa Companion** (sur le PC) : activer « Autoriser les appareils LAN à se connecter », ouvrir la page
« Appareils LAN », générer un token pour l'identifiant `smallrig` (= `DEVICE_ID`), le coller dans `.env`.
`COMPANION_URL` doit pointer vers l'IP du PC : `ws://<ip-du-pc>:8786/devices/ws`.

## Appairage

1. Réinitialiser la lampe (selon son mode d'emploi) pour qu'elle se remette à annoncer qu'elle est à appairer.
2. `.venv/bin/python -m klixa_smallrig scan` pour vérifier qu'elle est vue, puis
   `.venv/bin/python -m klixa_smallrig pair --name "Bureau"`.
3. `.venv/bin/python -m klixa_smallrig run` : la lampe apparaît dans Klixa.

L'identifiant d'une lampe est son uuid matériel : il ne change pas quand on la ré-appaire.

## Utilisation

```bash
python -m klixa_smallrig run                       # expose les lampes au compagnon (à laisser tourner)
python -m klixa_smallrig scan [--timeout 8]        # lampes à portée
python -m klixa_smallrig pair [--index N] [--name X]   # appairer une nouvelle lampe (la réinitialiser d'abord)
python -m klixa_smallrig list                      # lampes appairées
python -m klixa_smallrig reconfigure <uuid>        # si une lampe est appairée mais ignore les commandes
python -m klixa_smallrig forget <uuid> [--force]   # oublier une lampe (--force : sans la réinitialiser)
python -m klixa_smallrig status <uuid>             # état et batterie
```

**Un seul processus à la fois** utilise l'état mesh : arrêtez `run` avant `pair`, `forget` ou `reconfigure`.
Ne lancez pas non plus en même temps la version Node.js (même `DEVICE_ID`, même fichier d'état possible).

Pour démarrer avec la machine : [`klixa-smallrig.service`](klixa-smallrig.service) (adapter l'utilisateur et les
chemins), puis

```bash
sudo cp klixa-smallrig.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now klixa-smallrig
journalctl -u klixa-smallrig -f
```

## Ce que Klixa voit

| Élément | Valeur |
| --- | --- |
| Appareil | `DEVICE_ID` (défaut `smallrig`) |
| Élément (une lampe) | `type: "light"`, `id` = uuid mesh de la lampe |
| Capacités | `onoff`, `dimming`, `color`, `color_temperature` |
| Effets | les 12 effets matériels RM75 (`fx` = numéro de mode, « 1 » à « 12 ») |
| `getState` | dernier état écrit par ce script (restauration après un effet temporaire) |

La restauration après un effet temporaire est faite par le compagnon (`getState` puis `set`). Un état changé hors de
ce script (app SmallGoGo, boutons de la lampe) n'est pas vu : la lampe revient au dernier état écrit.

La liste des lampes est lue au démarrage : après un `pair` ou un `forget`, relancer `run`.

## Compatibilité avec la version Node.js

Le fichier d'état (`smallrig-mesh-state.json`, clés réseau + lampes + séquences) a **le même format** : un état
produit par l'une des versions est relu par l'autre, sans réappairer les lampes. Copiez-le simplement sur l'autre
machine (et n'utilisez jamais les deux en parallèle : les numéros de séquence seraient réutilisés).

## Sécurité

- `smallrig-mesh-state.json` contient les clés du réseau mesh : droits `0600`, jamais versionné.
- Le token d'appareil ne permet de se faire passer que pour cet appareil auprès du compagnon.
- Réseau local uniquement : n'exposez rien sur Internet.

## Tests

```bash
pip install -r requirements.txt
python -m unittest discover -s tests
```

`tests/node_vectors.json` fige les sorties de l'implémentation Node (`devices/smallrig/src/ble`) pour une série
d'entrées ; le test de parité casse si le portage s'en écarte. Seule la liaison Bluetooth réelle (`ble.py`) n'est
pas testable sans matériel.
