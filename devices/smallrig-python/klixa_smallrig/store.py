"""État persistant du réseau mesh : NetKey, AppKey, IVIndex, SEQ (réservé par blocs) et nœuds provisionnés
(DevKey + adresse unicast + UUID). Fonctions pures sur un dict.

Le format JSON est IDENTIQUE à celui de la version Node.js (clés camelCase) : un fichier d'état produit par
l'une des deux versions est relu par l'autre."""
import json
import re

from .crypto import random_bytes

PROVISIONER_ADDRESS = 0x0001
FIRST_NODE_ADDRESS = 0x0002
MAX_UNICAST_ADDRESS = 0x7FFF
MAX_SEQ = 0xFFFFFF
SEQ_EXCLUSIVE_LIMIT = MAX_SEQ + 1
DEFAULT_SEQ_BLOCK_SIZE = 100
CONFIGURATION_STATUSES = ("unknown", "pending", "configured", "provisioning-uncertain")

_KEY_RE = re.compile(r"^[0-9a-fA-F]{32}$")


class MeshStateError(ValueError):
    code = "INVALID_MESH_STATE"

    def __init__(self, message):
        super().__init__(f"État mesh SmallRig invalide : {message}")


class SeqExhaustedError(Exception):
    code = "SEQ_EXHAUSTED"


def create_empty_mesh_state():
    return {
        "netKey": None, "appKey": None, "ivIndex": 0,
        "provisionerAddress": PROVISIONER_ADDRESS, "nextUnicastAddress": FIRST_NODE_ADDRESS,
        "seq": 0, "seqAllocatedUpTo": 0, "pendingProvisioning": None, "pendingNodeReset": None, "nodes": [],
    }


def _integer(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise MeshStateError(label)
    return value


def _key(value, label):
    if not isinstance(value, str) or not _KEY_RE.match(value):
        raise MeshStateError(f"{label} doit contenir 16 octets hexadécimaux")
    return value.lower()


def _normalize_stored_node(node, label="nœud"):
    if not isinstance(node, dict):
        raise MeshStateError(f"{label} mal formé")
    uuid = node.get("uuid")
    if not isinstance(uuid, str) or not _KEY_RE.match(uuid):
        raise MeshStateError(f"{label}.uuid invalide")
    unicast = _integer(node.get("unicastAddress"), FIRST_NODE_ADDRESS, MAX_UNICAST_ADDRESS,
                       f"{label}.unicastAddress hors plage")
    count = _integer(node.get("elementCount"), 1, 255, f"{label}.elementCount hors plage")
    if unicast + count - 1 > MAX_UNICAST_ADDRESS:
        raise MeshStateError(f"{label} dépasse la plage unicast")
    vendor = node.get("vendorElementAddress")
    vendor = unicast if vendor is None else _integer(vendor, unicast, unicast + count - 1,
                                                    f"{label}.vendorElementAddress hors du nœud")
    status = node.get("configurationStatus") or "unknown"
    if status not in CONFIGURATION_STATUSES:
        raise MeshStateError(f"{label}.configurationStatus invalide")
    error = node.get("configurationError")
    return {**node, "uuid": uuid.lower(), "name": node.get("name") or uuid.lower(), "unicastAddress": unicast,
            "elementCount": count, "deviceKey": _key(node.get("deviceKey"), f"{label}.deviceKey"),
            "vendorElementAddress": vendor, "configurationStatus": status,
            "configurationError": error if isinstance(error, str) else None}


def parse_mesh_state(text):
    if not text:
        return create_empty_mesh_state()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise MeshStateError(f"JSON illisible ({error})") from error
    if not isinstance(parsed, dict):
        raise MeshStateError("racine JSON non objet")

    empty = create_empty_mesh_state()
    net_key = None if parsed.get("netKey") is None else _key(parsed["netKey"], "netKey")
    app_key = None if parsed.get("appKey") is None else _key(parsed["appKey"], "appKey")
    if bool(net_key) != bool(app_key):
        raise MeshStateError("NetKey et AppKey doivent être présentes ensemble")
    iv_index = _integer(parsed.get("ivIndex", empty["ivIndex"]), 0, 0xFFFFFFFF, "ivIndex hors plage")
    provisioner = _integer(parsed.get("provisionerAddress", empty["provisionerAddress"]), 1, MAX_UNICAST_ADDRESS,
                           "provisionerAddress hors plage")
    next_unicast = _integer(parsed.get("nextUnicastAddress", empty["nextUnicastAddress"]), FIRST_NODE_ADDRESS,
                            MAX_UNICAST_ADDRESS + 1, "nextUnicastAddress hors plage")
    seq = _integer(parsed.get("seq", 0), 0, SEQ_EXCLUSIVE_LIMIT, "seq hors plage")
    high_water = _integer(parsed.get("seqAllocatedUpTo", seq), 0, SEQ_EXCLUSIVE_LIMIT, "seqAllocatedUpTo hors plage")
    if high_water < seq:
        raise MeshStateError("seq dépasse sa borne durable")
    resumed_seq = max(seq, high_water)
    raw_nodes = parsed.get("nodes")
    if raw_nodes is not None and not isinstance(raw_nodes, list):
        raise MeshStateError("nodes doit être un tableau")
    nodes = [_normalize_stored_node(node, f"nodes[{index}]") for index, node in enumerate(raw_nodes or [])]

    pending_provisioning = None
    if parsed.get("pendingProvisioning") is not None:
        normalized = _normalize_stored_node({**parsed["pendingProvisioning"],
                                             "configurationStatus": "provisioning-uncertain"}, "pendingProvisioning")
        pending_provisioning = {**parsed["pendingProvisioning"], **normalized}
        existing = next((node for node in nodes if node["uuid"] == normalized["uuid"]), None)
        if existing and (existing["unicastAddress"] != normalized["unicastAddress"]
                         or existing["elementCount"] != normalized["elementCount"]
                         or existing["deviceKey"] != normalized["deviceKey"]):
            raise MeshStateError("pendingProvisioning contredit le nœud conservé du même UUID")
        if not existing:
            nodes.append({**normalized, "configurationStatus": "provisioning-uncertain",
                          "configurationError": "Provisioning interrompu avant confirmation Complete"})

    pending_reset = None
    if parsed.get("pendingNodeReset") is not None:
        raw = parsed["pendingNodeReset"]
        if not isinstance(raw, dict) or not isinstance(raw.get("uuid"), str) or not _KEY_RE.match(raw["uuid"]):
            raise MeshStateError("pendingNodeReset mal formé")
        pending_reset = {**raw, "uuid": raw["uuid"].lower()}

    seen, ranges = set(), []
    for node in nodes:
        if node["uuid"] in seen:
            raise MeshStateError(f"UUID dupliqué ({node['uuid']})")
        seen.add(node["uuid"])
        start, end = node["unicastAddress"], node["unicastAddress"] + node["elementCount"] - 1
        if start <= provisioner <= end:
            raise MeshStateError(f"adresse du provisioner chevauche {node['uuid']}")
        for other in ranges:
            if start <= other[1] and end >= other[0]:
                raise MeshStateError(f"plages unicast chevauchantes ({other[2]}/{node['uuid']})")
        ranges.append((start, end, node["uuid"]))
    highest = max([end for _, end, _ in ranges], default=FIRST_NODE_ADDRESS - 1)
    if next_unicast <= highest:
        raise MeshStateError("nextUnicastAddress réutiliserait une plage déjà attribuée")
    if nodes and (not net_key or not app_key):
        raise MeshStateError("des nœuds existent sans NetKey/AppKey")
    if pending_reset and not any(node["uuid"] == pending_reset["uuid"] for node in nodes):
        raise MeshStateError("pendingNodeReset ne correspond à aucun nœud conservé")

    # `seqAllocatedUpTo` est une borne exclusive déjà durable : après un crash, tous les SEQ du bloc ont
    # potentiellement été vus, on reprend donc à la borne et jamais au compteur sauvegardé en début de bloc.
    return {**empty, **parsed, "netKey": net_key, "appKey": app_key, "ivIndex": iv_index,
            "provisionerAddress": provisioner, "nextUnicastAddress": next_unicast, "seq": resumed_seq,
            "seqAllocatedUpTo": max(resumed_seq, high_water), "pendingProvisioning": pending_provisioning,
            "pendingNodeReset": pending_reset, "nodes": nodes}


def serialize_mesh_state(state):
    return json.dumps(state)


def ensure_network_keys(state):
    """Génère NetKey/AppKey localement au premier provisioning (jamais fournies par le cloud)."""
    if not state.get("netKey"):
        state["netKey"] = random_bytes(16).hex()
    if not state.get("appKey"):
        state["appKey"] = random_bytes(16).hex()
    return state


def net_key_bytes(state):
    return bytes.fromhex(state["netKey"])


def app_key_bytes(state):
    return bytes.fromhex(state["appKey"])


def allocate_unicast_address(state, element_count):
    """Réserve un bloc d'adresses unicast pour un nœud de `element_count` éléments."""
    if not isinstance(element_count, int) or element_count < 1 or element_count > 255:
        raise ValueError("Nombre d'éléments invalide pour l'allocation unicast")
    address = state["nextUnicastAddress"]
    provisioner = state.get("provisionerAddress") or PROVISIONER_ADDRESS
    if address <= provisioner <= address + element_count - 1:
        address = provisioner + 1
    if address + element_count - 1 > MAX_UNICAST_ADDRESS:
        raise ValueError("Plage d'adresses unicast épuisée")
    state["nextUnicastAddress"] = address + element_count
    return address


def next_seq(state, block_size=DEFAULT_SEQ_BLOCK_SIZE):
    """SEQ avec réservation par blocs : quand `seq` atteint la borne persistée, on avance la borne AVANT de
    renvoyer le numéro ; `crossed_boundary` indique qu'il faut persister l'état avant d'émettre ce message
    (sinon un crash ferait réutiliser un SEQ déjà vu par les nœuds, message alors ignoré en silence)."""
    seq = state["seq"]
    if not isinstance(seq, int) or seq < 0:
        raise ValueError("SEQ mesh invalide")
    if seq > MAX_SEQ:
        raise SeqExhaustedError("SEQ mesh 24 bits épuisé — IV Update requis avant tout nouvel envoi")
    size = max(1, int(block_size) or DEFAULT_SEQ_BLOCK_SIZE)
    crossed = False
    if seq >= state["seqAllocatedUpTo"]:
        state["seqAllocatedUpTo"] = min(SEQ_EXCLUSIVE_LIMIT, seq + size)
        crossed = True
    state["seq"] = seq + 1
    return seq, crossed


def add_node(state, *, uuid, name, unicast_address, element_count, device_key, vendor_element_address=None,
             configuration_status="pending", configuration_error=None):
    node = {
        "uuid": uuid, "name": name or uuid, "unicastAddress": unicast_address, "elementCount": element_count,
        "deviceKey": device_key.hex() if isinstance(device_key, (bytes, bytearray)) else device_key,
        "vendorElementAddress": unicast_address if vendor_element_address is None else vendor_element_address,
        "configurationStatus": configuration_status, "configurationError": configuration_error,
    }
    state["nodes"] = [n for n in state["nodes"] if n["uuid"] != uuid] + [node]
    return node


def set_pending_provisioning(state, pending):
    state["pendingProvisioning"] = dict(pending) if pending else None
    return state["pendingProvisioning"]


def clear_pending_provisioning(state, uuid=None):
    pending = state.get("pendingProvisioning")
    if not uuid or (pending and pending.get("uuid") == uuid):
        state["pendingProvisioning"] = None


def remove_node(state, uuid):
    before = len(state["nodes"])
    state["nodes"] = [n for n in state["nodes"] if n["uuid"] != uuid]
    return len(state["nodes"]) < before


def find_node(state, uuid):
    return next((n for n in state["nodes"] if n["uuid"] == uuid), None)


def node_device_key_bytes(node):
    return bytes.fromhex(node["deviceKey"])
