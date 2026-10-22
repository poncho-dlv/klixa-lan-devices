# Machine à fumée (relais électronique)

Un Raspberry Pi ferme un **relais** pendant une durée bornée pour déclencher une machine à fumée. Klixa
envoie l'ordre — depuis la console, une automatisation (follow, raid, récompense, commande de chat…) — via
le compagnon. Le script se connecte au compagnon : **aucun port à ouvrir sur le Pi**.

## Matériel

- Un Raspberry Pi (ou compatible `gpiozero`) sur le même réseau local que le PC du compagnon.
- Un **module relais** (entrée logique 3,3 V, actif haut) : `IN` sur le **GPIO 17** (BCM, broche physique 11),
  alimentation `VCC`/`GND` du module sur le Pi. La broche se change avec `SMOKE_GPIO_PIN`.
- Le contact du relais se câble **en parallèle du bouton de la télécommande filaire** de la machine (basse
  tension), pas sur le secteur. Ne commutez le 230 V que si vous savez le faire en sécurité.

## Installation

```bash
sudo apt update && sudo apt install -y python3 python3-pip
mkdir -p ~/klixa-device-agent && cd ~/klixa-device-agent
# Copier ici : smoke_relay.py, klixa_device_agent.py, requirements.txt, .env.example
pip3 install -r requirements.txt --break-system-packages
cp .env.example .env     # puis renseigner COMPANION_URL et DEVICE_TOKEN
python3 smoke_relay.py
```

`klixa_device_agent.py` est une copie du SDK de [`../../sdk/python`](../../sdk/python) (un test vérifie qu'elles
restent identiques). Les deux fichiers `.py` doivent être dans le **même dossier**.

### Token

Dans l'app Klixa Companion : page « Appareils LAN » → **Générer un token**. Donnez l'identifiant que vous mettez
dans `DEVICE_ID` (par défaut `smoke-machine`), copiez le token tout de suite (affiché une seule fois) dans `.env`.

### Démarrage automatique (systemd)

```bash
sudo cp klixa-smoke-relay.service /etc/systemd/system/    # adapter User et chemins
sudo systemctl daemon-reload
sudo systemctl enable --now klixa-smoke-relay
journalctl -u klixa-smoke-relay -f
```

## Dans Klixa

L'appareil apparaît « connecté » dans le compagnon, puis dans la console (Paramètres → Compagnon → Appareils
LAN, avec un bouton de test) et dans l'action **« Appareil LAN »** des automatisations : choisissez `Relais
fumée` / `trigger` et la durée de l'impulsion.

## Garde-fous

- Durée **bornée** à `[SMOKE_MIN_MS, SMOKE_MAX_MS]` (50–1500 ms par défaut) : Klixa ne peut pas laisser le relais
  fermé.
- **Une seule impulsion à la fois** : une commande reçue pendant une impulsion échoue (« Impulsion déjà en cours »)
  au lieu de s'empiler.
- Le relais retombe à `off` dans un `finally`, même en cas d'erreur pendant l'impulsion (pas de garde contre un
  `kill -9` du processus).
- Ne l'exposez jamais sur Internet.

## Tests

```bash
python3 -m unittest discover -s tests
```

La logique d'impulsion est testée avec un faux relais (aucun matériel requis).
