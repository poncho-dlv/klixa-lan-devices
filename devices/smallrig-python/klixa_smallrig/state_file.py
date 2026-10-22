"""Persistance durable de l'état mesh : écriture atomique (fichier temporaire + fsync + rename), droits 0600.

Sans persistance fiable, une mutation mesh échoue AVANT l'émission : on évite ainsi la perte d'une DevKey ou la
réutilisation de numéros de séquence au prochain redémarrage."""
import asyncio
import os
import uuid
from pathlib import Path


def _fsync_directory(directory):
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(file, content):
    file = Path(file)
    directory = file.parent
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f".{file.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file)
        _fsync_directory(directory)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def load_persisted_state(file):
    """Renvoie le JSON de l'état ('' si le fichier n'existe pas encore). Lève si le fichier est illisible/vide."""
    file = Path(file)
    try:
        if os.name != "nt":
            os.chmod(file, 0o600)
        persisted = file.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise RuntimeError(f"État Mesh SmallRig illisible ({file}) : {error}") from error
    if not persisted:
        raise RuntimeError(f"État Mesh SmallRig illisible ({file}) : le fichier existe mais il est vide")
    return persisted


def make_state_writer(file):
    async def write(mesh_state_json):
        await asyncio.get_running_loop().run_in_executor(None, atomic_write, file, mesh_state_json + "\n")
    return write
