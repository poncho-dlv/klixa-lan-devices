# SmallRig RM75 — lampes Bluetooth Mesh

Lampes **SmallRig RM75** (Bluetooth Mesh) exposées à Klixa comme un **appareil LAN**.

Le support SmallRig repose sur du reverse engineering du protocole de l'app SmallGoGo : il ne fait plus
partie de Klixa ni du compagnon. Ce script en reprend le code (`src/ble/`, inchangé) et le branche sur le
protocole des appareils LAN du compagnon (voir `klixa-companion/protocol/devices-messages.md` et
<https://klixa.live/docs/devices>) : chaque lampe appairée devient un élément `light`, pilotable depuis
les thèmes, les alertes, le BPM et les automatisations de Klixa comme n'importe quelle lampe LAN.

```
Klixa (cloud) ⇄ Klixa Companion ⇄ ce script ⇄ (Bluetooth Mesh) ⇄ lampes RM75
```

> **Statut :** le code Bluetooth/mesh est celui qui tournait dans le compagnon ; l'adaptation au protocole
> des appareils LAN (annonce des lampes, `set`, `getState`) est couverte par des tests, mais **n'a pas été
> validée sur une lampe réelle**. La plage de température (2500–10000 K) est une valeur usuelle non confirmée.

## Prérequis

- Node.js ≥ 20.6, sur la machine qui est à portée Bluetooth des lampes (souvent le PC du streamer).
- Un adaptateur Bluetooth LE actif.
- Windows : la bibliothèque `webbluetooth` doit être reconstruite avec le correctif GATT du dépôt
  (`npm run build:webbluetooth:win`, nécessite CMake et les outils de build C++ Visual Studio). Les
  correctifs sont dans `patches/`, appliqués par `patch-package` à l'installation.

## Installation

```bash
npm install
npm run build:webbluetooth:win     # Windows uniquement
cp .env.example .env               # puis renseigner DEVICE_TOKEN
```

Dans l'app **Klixa Companion** : activer « Autoriser les appareils LAN à se connecter », ouvrir la page
« Appareils LAN », générer un token pour l'identifiant `smallrig` (= `DEVICE_ID`), le coller dans `.env`.

## Appairage

1. Réinitialiser la lampe (selon son mode d'emploi) pour qu'elle se remette à annoncer qu'elle est à appairer.
2. `npm run cli -- scan` pour vérifier qu'elle est vue, puis `npm run cli -- pair --name "Bureau"`.
3. `npm run cli -- run` : la lampe apparaît dans Klixa.

L'identifiant d'une lampe est son uuid matériel : il ne change pas quand on la ré-appaire.

## Utilisation

```bash
npm run cli -- run                         # expose les lampes au compagnon (à laisser tourner)
npm run cli -- scan                        # lampes à portée
npm run cli -- pair [--index N] [--name X] # appairer une nouvelle lampe (la réinitialiser d'abord)
npm run cli -- list                        # lampes appairées
npm run cli -- reconfigure <uuid>          # si une lampe est appairée mais ignore les commandes
npm run cli -- forget <uuid> [--force]     # oublier une lampe
npm run cli -- status <uuid>               # état et batterie
```

**Un seul processus à la fois** utilise l'état mesh : arrêtez `run` avant `pair`, `forget` ou `reconfigure`.

Pour démarrer avec la machine : tâche planifiée Windows (« à l'ouverture de session », commande
`npm run start` dans ce dossier) ou service `systemd` sous Linux.

## Ce que Klixa voit

| Élément | Valeur |
| --- | --- |
| Appareil | `DEVICE_ID` (défaut `smallrig`) |
| Élément (une lampe) | `type: "light"`, `id` = uuid mesh de la lampe |
| Capacités | `onoff`, `dimming`, `color`, `color_temperature` |
| Effets | les 12 effets matériels RM75 (`fx` = numéro de mode, « 1 » à « 12 ») |
| `getState` | dernier état écrit par ce script (restauration après un effet temporaire) |

La restauration après un effet temporaire est faite par le compagnon (`getState` puis `set`). Un état changé
hors de ce script (app SmallGoGo, boutons de la lampe) n'est pas vu : la lampe revient au dernier état écrit.

## Sécurité

- `smallrig-mesh-state.json` contient les clés du réseau mesh : droits `0600`, jamais versionné.
- Le token d'appareil ne permet de se faire passer que pour cet appareil auprès du compagnon.
- Réseau local uniquement : n'exposez rien sur Internet.

## Tests

`npm test` — la partie Bluetooth réelle (`src/ble/ble-transport.js`) n'est pas testable sans matériel.

Documentation du protocole des lampes : `docs/RM75_SPEC_DEV.md`, `docs/RM75_protocole.md`.
