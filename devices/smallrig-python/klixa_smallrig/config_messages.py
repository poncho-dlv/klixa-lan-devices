"""Messages de configuration standard Bluetooth Mesh après provisioning (composition data, AppKey Add,
Model App Bind), chiffrés avec la DevKey du nœud. Pur."""
APP_KEY_ADD = 0x00
COMPOSITION_DATA_STATUS = 0x02
COMPOSITION_DATA_GET = 0x8008
APP_KEY_STATUS = 0x8003
MODEL_APP_BIND = 0x803D
MODEL_APP_STATUS = 0x803E
NODE_RESET = 0x8049
NODE_RESET_STATUS = 0x804A


def encode_config_opcode(value):
    if value < 0x100:
        return bytes([value])
    return bytes([(value >> 8) & 0xFF, value & 0xFF])


def decode_access_opcode(data):
    """Décode l'opcode en tête d'un Access Payload : {opcode, length, is_vendor, params}."""
    data = bytes(data)
    if not data:
        raise ValueError("Access Payload vide")
    first = data[0]
    if first < 0x80:
        return {"opcode": first, "length": 1, "is_vendor": False, "params": data[1:]}
    if first < 0xC0:
        if len(data) < 2:
            raise ValueError("Opcode Access 2 octets tronqué")
        return {"opcode": (data[0] << 8) | data[1], "length": 2, "is_vendor": False, "params": data[2:]}
    if len(data) < 3:
        raise ValueError("Opcode Access vendor tronqué")
    return {"opcode": None, "length": 3, "is_vendor": True, "params": data[3:]}


def encode_composition_data_get(page=0):
    return encode_config_opcode(COMPOSITION_DATA_GET) + bytes([page])


def parse_composition_data_page0(params):
    """Analyse minimale de la Composition Data Status (page 0)."""
    params = bytes(params)
    if len(params) < 11:
        raise ValueError("Composition Data Status trop courte")
    if params[0] != 0x00:
        raise ValueError(f"Composition Data Status page inattendue ({params[0]})")
    offset = 11
    elements = []
    while offset < len(params):
        if offset + 4 > len(params):
            raise ValueError("Composition Data : en-tête élément tronqué")
        location = int.from_bytes(params[offset:offset + 2], "little")
        num_s, num_v = params[offset + 2], params[offset + 3]
        offset += 4
        if offset + num_s * 2 + num_v * 4 > len(params):
            raise ValueError("Composition Data : liste de modèles tronquée")
        sig_models = []
        for _ in range(num_s):
            sig_models.append(int.from_bytes(params[offset:offset + 2], "little"))
            offset += 2
        vendor_models = []
        for _ in range(num_v):
            cid = int.from_bytes(params[offset:offset + 2], "little")
            model_id = int.from_bytes(params[offset + 2:offset + 4], "little")
            # Convention : ModelId « logique » 4 octets = ModelID (16 bits hauts) | CID (16 bits bas).
            vendor_models.append((model_id << 16) | cid)
            offset += 4
        elements.append({"location": location, "sig_models": sig_models, "vendor_models": vendor_models})
    return {"page": 0, "elements": elements}


def encode_app_key_add(app_key, net_key_index=0, app_key_index=0):
    packed = bytes([net_key_index & 0xFF, ((app_key_index & 0x0F) << 4) | ((net_key_index >> 8) & 0x0F),
                    (app_key_index >> 4) & 0xFF])
    return encode_config_opcode(APP_KEY_ADD) + packed + bytes(app_key)


def decode_app_key_status(params):
    params = bytes(params)
    if len(params) != 4:
        raise ValueError("App Key Status mal formé")
    return {"status": params[0], "ok": params[0] == 0, "net_key_index": params[1] | ((params[2] & 0x0F) << 8),
            "app_key_index": ((params[2] >> 4) & 0x0F) | (params[3] << 4)}


def encode_model_app_bind(element_address, model_id, app_key_index=0, is_vendor_model=True):
    model = model_id.to_bytes(4 if is_vendor_model else 2, "little")
    return (encode_config_opcode(MODEL_APP_BIND) + element_address.to_bytes(2, "little")
            + app_key_index.to_bytes(2, "little") + model)


def decode_model_app_status(params):
    params = bytes(params)
    if len(params) not in (7, 9):
        raise ValueError("Model App Status mal formé")
    is_vendor = len(params) == 9
    return {"status": params[0], "ok": params[0] == 0,
            "element_address": int.from_bytes(params[1:3], "little"),
            "app_key_index": int.from_bytes(params[3:5], "little") & 0x0FFF,
            "model_id": int.from_bytes(params[5:9] if is_vendor else params[5:7], "little"),
            "is_vendor_model": is_vendor}
