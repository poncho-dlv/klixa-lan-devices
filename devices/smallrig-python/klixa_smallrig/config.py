"""Configuration par variables d'environnement (voir .env.example) et lecture d'un fichier `.env`."""
import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path=".env"):
    """Charge un fichier `.env` simple (CLE=valeur) SANS écraser l'environnement déjà posé."""
    file = Path(path)
    if not file.is_file():
        return
    for raw in file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def _int(value, fallback):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True)
class Config:
    companion_url: str
    device_token: str
    device_id: str
    device_name: str
    mesh_state_file: str
    max_lamps: int
    seq_block_size: int


def load_config(env=None):
    env = os.environ if env is None else env
    return Config(
        # Adresse du compagnon et token généré dans l'app Klixa Companion (page « Appareils LAN »).
        companion_url=str(env.get("COMPANION_URL") or "ws://127.0.0.1:8786/devices/ws").strip(),
        device_token=str(env.get("DEVICE_TOKEN") or "").strip(),
        device_id=str(env.get("DEVICE_ID") or "smallrig").strip(),
        device_name=str(env.get("DEVICE_NAME") or "Lampes SmallRig").strip(),
        # État mesh (clés réseau, nœuds, séquences) : secret, persisté de façon atomique.
        mesh_state_file=str(env.get("SMALLRIG_MESH_STATE_FILE") or "./smallrig-mesh-state.json").strip(),
        max_lamps=_int(env.get("SMALLRIG_MAX_LAMPS"), 50),
        seq_block_size=_int(env.get("SMALLRIG_SEQ_BLOCK_SIZE"), 100),
    )
