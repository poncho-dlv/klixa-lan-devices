# klixa-lan-devices

Scripts d'**appareils LAN** pour [Klixa](https://klixa.live) : du matériel de votre réseau local (relais,
lampes, prises…) piloté depuis Klixa — console, automatisations, thèmes, alertes — grâce à un petit script
qui se connecte au **compagnon Klixa**.

```
Klixa (cloud) ⇄ Klixa Companion (votre PC) ⇄ un script de ce dépôt ⇄ votre matériel
```

Le script se connecte **au compagnon** (WebSocket sortant) : aucun port à ouvrir, le compagnon n'a pas besoin
de connaître l'adresse du script. Protocole et guide complets : <https://klixa.live/docs/devices> et
[`protocol/devices-messages.md`](https://github.com/poncho-dlv/klixa-companion/blob/main/protocol/devices-messages.md)
dans le dépôt du compagnon.

## Les appareils

| Dossier | Matériel | Langage | Type Klixa |
| --- | --- | --- | --- |
| [`devices/smoke-machine`](devices/smoke-machine) | Machine à fumée commandée par un **relais électronique** (Raspberry Pi, GPIO) | Python | élément `switch` (impulsion à durée bornée) |
| [`devices/smallrig`](devices/smallrig) | Lampes **SmallRig RM75** (Bluetooth Mesh) | Node.js | éléments `light` (couleur, intensité, blanc réglable, effets) |
| [`devices/smallrig-python`](devices/smallrig-python) | Lampes **SmallRig RM75** (Bluetooth Mesh) — portage Python du précédent, recommandé sur Raspberry Pi | Python | éléments `light` (identiques) |

Chaque dossier est **autonome** (son propre README, ses dépendances, ses tests) : on ne déploie que ce dont on a
besoin, sur la machine qui est branchée au matériel.

## Écrire le vôtre

Le dossier [`sdk/python`](sdk/python) contient le SDK de référence (`klixa_device_agent.py`, une seule
dépendance : `websockets`). Un appareil tient en quelques lignes :

```python
from klixa_device_agent import DeviceAgent

agent = DeviceAgent(companion_url="ws://192.168.1.30:8786/devices/ws", token="kxd_...",
                    device_id="mon-appareil", name="Mon appareil")

@agent.action("relay", "trigger", params={"durationMs": {"min": 50, "max": 1500, "default": 300}})
def trigger(payload, data):
    ...  # votre matériel
    return {}

agent.run()
```

Pour une **lampe**, utilisez `agent.light(...)` (voir [`sdk/python/README.md`](sdk/python/README.md)) : Klixa la
propose alors dans les thèmes, les alertes, le BPM et les automatisations, comme une lampe Hue.
Le client Node.js de référence est [`devices/smallrig/src/device-agent.js`](devices/smallrig/src/device-agent.js).

## Mise en place commune

1. Dans l'app **Klixa Companion** : activer « Autoriser les appareils LAN à se connecter ».
2. Page « Appareils LAN » du compagnon → **Générer un token** pour l'identifiant de l'appareil
   (`smoke-machine`, `smallrig`…) ; le token n'est affiché qu'une fois.
3. Renseigner `COMPANION_URL`, `DEVICE_TOKEN`, `DEVICE_ID` dans le `.env` du dossier de l'appareil.
4. Lancer le script ; l'appareil apparaît dans Klixa (Paramètres → Compagnon → Appareils LAN, Automatisations).

La fonctionnalité « Appareils LAN » peut être réservée au plan Premium selon la configuration de votre instance.

## Tests

```bash
npm test          # test anti-dérive du SDK + tests Python (SDK, smoke-machine, smallrig-python)
```

Les tests Python demandent `pip install websockets cryptography bleak`. Les tests de `devices/smallrig` se lancent depuis son dossier
(`npm install`, `npm test`) : le code Bluetooth réel n'est pas testable sans matériel.

## Sécurité

- Un **token par appareil** : un token compromis ne permet de se faire passer que pour cet appareil. Ne le
  commitez jamais (`.env` est ignoré).
- Réseau local uniquement : n'exposez jamais un de ces scripts ni son matériel sur Internet.
- Bornez dans votre script tout ce qui est dangereux (durée d'un relais, puissance…) : Klixa transmet ce qu'on
  lui demande.

Licence Apache-2.0.
