# SDK Python

`klixa_device_agent.py` : client du protocole des appareils LAN (connexion WebSocket sortante vers le compagnon
Klixa, annonce des éléments, exécution des commandes, reconnexion automatique). Une seule dépendance :
`websockets`.

```bash
pip install websockets
```

Copiez le fichier à côté de votre script.

## Un relais, un bouton, une prise…

```python
agent = DeviceAgent(companion_url="ws://192.168.1.30:8786/devices/ws", token="kxd_...",
                    device_id="mon-appareil", name="Mon appareil")

@agent.action("relay", "trigger", params={"durationMs": {"min": 50, "max": 1500, "default": 300}})
def trigger(payload, data):
    ...
    return {"durationMs": payload.get("durationMs", 300)}

agent.run()
```

`payload` est structuré par Klixa depuis les `params` déclarés ; `data` est un JSON libre jamais interprété.
Un handler peut être une fonction (exécutée dans un thread) ou une coroutine `async def`.

## Une lampe

```python
lamp = agent.light("strip", name="Ruban", capabilities=["onoff", "dimming", "color"],
                   kelvin=(2000, 6500), fx_modes={"rainbow": "Arc-en-ciel"})

@lamp.set
def set_strip(state, data):
    # state ne contient QUE ce que la lampe supporte : {"on": True, "color": "#FF8800", "brightness": 70} ou {"on": False}
    ...

@lamp.get_state          # facultatif : permet à Klixa de rendre à la lampe son état d'avant (effet temporaire)
def get_strip():
    return {"on": True, "color": "#FFFFFF", "brightness": 100}
```

Klixa propose alors la lampe dans les thèmes, les alertes, le BPM et les automatisations. Le protocole 2 est
annoncé automatiquement dès qu'une lampe est déclarée.

## Tests

```bash
python -m unittest discover -s tests
```

Ils démarrent un faux compagnon (serveur WebSocket local) et vérifient le `hello`, les `ack` et les lampes.
