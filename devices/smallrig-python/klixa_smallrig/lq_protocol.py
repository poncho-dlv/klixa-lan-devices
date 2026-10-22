"""Protocole applicatif « Lq » des lampes SmallRig RM75 : encode/décode des trames, indépendant du transport.
Format des commandes : [opcode][len][xor][payload...]."""
OP_CAPACITY, OP_VERSION, OP_HSI, OP_CCT, OP_FX, OP_RGBW = 0x31, 0x32, 0x33, 0x34, 0x35, 0x36
OP_LUM, OP_STATUS = 0x42, 0x43

LUM_ON, LUM_OFF = 0xFE00, 0xFC00
FX_PAPARAZZI = 1
_FX_ONE_PARAMETER_MODES = {3, 6, 8, 11, 12}  # éclair, soudure, feu d'artifice, TV, ampoule défectueuse

# Sous-opcode vendor « data » : concaténé littéralement à la trame Lq pour former l'Access Payload.
VENDOR_SUBOPCODE_DATA = 0x24
_AT_PREFIXES = (b"AT+DATAX@0001=", b"AT+DATA@0001=")


def _xor_all(data):
    result = 0
    for byte in data:
        result ^= byte
    return result & 0xFF


def clamp_int(value, low, high):
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return low
    return max(low, min(high, number))


def encode_control_frame(opcode, payload):
    body = bytes(payload)
    return bytes([opcode, len(body), _xor_all(body)]) + body


def encode_hsi(hue, sat, intensity):
    h = clamp_int(hue, 0, 360)
    return encode_control_frame(OP_HSI, [(h >> 8) & 0xFF, h & 0xFF, clamp_int(sat, 0, 100), clamp_int(intensity, 0, 100)])


def encode_cct(kelvin, intensity, gm=0):
    k = clamp_int(kelvin, 0, 0xFFFF)
    return encode_control_frame(OP_CCT, [(k >> 8) & 0xFF, k & 0xFF, clamp_int(intensity, 0, 100),
                                         (clamp_int(gm, -10, 10) + 10) * 5])


def encode_rgbw(r, g, b, w=0):
    return encode_control_frame(OP_RGBW, [clamp_int(c, 0, 255) for c in (r, g, b, w)])


def encode_fx(mode, param1=0, param2=0):
    m = clamp_int(mode, 1, 12)
    payload = [m, 5, clamp_int(param1, 0, 255)]
    if m == FX_PAPARAZZI:
        p2 = clamp_int(param2, 0, 0xFFFF)
        payload += [(p2 >> 8) & 0xFF, p2 & 0xFF]
    elif m not in _FX_ONE_PARAMETER_MODES:
        payload.append(clamp_int(param2, 0, 255))
    return encode_control_frame(OP_FX, payload)


def encode_lum_level(percent):
    v = clamp_int(percent, 0, 100)
    return encode_control_frame(OP_LUM, [(v >> 8) & 0xFF, v & 0xFF])


def encode_lum_on():
    return encode_control_frame(OP_LUM, [(LUM_ON >> 8) & 0xFF, LUM_ON & 0xFF])


def encode_lum_off():
    return encode_control_frame(OP_LUM, [(LUM_OFF >> 8) & 0xFF, LUM_OFF & 0xFF])


def encode_capacity_read():
    return bytes([OP_CAPACITY])


def encode_version_read():
    return bytes([OP_VERSION])


def encode_status_read():
    return bytes([OP_STATUS])


def strip_at_prefix(data):
    data = bytes(data)
    for prefix in _AT_PREFIXES:
        if data.startswith(prefix):
            return data[len(prefix):]
    return data


def decode_status(raw):
    """LqCStatus (0x43) : [mode][len][xor][v1..v4], vérification XOR obligatoire."""
    data = strip_at_prefix(raw)
    if len(data) < 3:
        raise ValueError("Trame de statut trop courte")
    mode, length = data[0], data[1]
    if len(data) != 3 + length:
        raise ValueError("Trame de statut : longueur incohérente")
    values = data[3:3 + length]
    if _xor_all(values) != data[2]:
        raise ValueError("Trame de statut : XOR invalide")
    required = {3: 4, 4: 4, 5: 3, 6: 4}
    if mode in required and length != required[mode]:
        raise ValueError(f"Trame de statut : longueur invalide pour le mode {mode}")
    if mode == 3:
        return {"type": "hsi", "hue": (values[0] << 8) + values[1], "sat": values[2], "intensity": values[3]}
    if mode == 4:
        return {"type": "cct", "kelvin": (values[0] << 8) + values[1], "intensity": values[2], "gm": values[3] - 10}
    if mode == 5:
        return {"type": "fx", "mode": values[0], "freq": values[1], "intensity": values[2]}
    if mode == 6:
        return {"type": "rgbw", "r": values[0], "g": values[1], "b": values[2], "w": values[3]}
    names = {7: "manual_cct", 8: "manual_hsi", 9: "pickup"}
    if mode in names:
        return {"type": names[mode], "raw": list(values)}
    return {"type": "unknown", "mode": mode, "raw": list(values)}


def decode_capacity(raw):
    """LqCapacity (0x31) : 8 octets ASCII (chiffres)."""
    data = strip_at_prefix(raw)
    if len(data) != 8 or not data.isdigit():
        raise ValueError("Trame de capacité invalide")
    digit = lambda i: data[i] - 0x30  # noqa: E731
    battery = digit(0) * 100 + digit(1) * 10 + digit(2)
    autonomy = digit(3) * 10 + digit(4) + digit(5) / 10
    if battery > 100 or digit(6) > 2 or digit(7) > 1:
        raise ValueError("Trame de capacité hors plage")
    return {"battery": battery, "autonomy_hours": autonomy,
            "charge_state": ["discharged", "charging", "full"][digit(6)], "powered_on": data[7] == 0x31}


def decode_version(raw):
    text = strip_at_prefix(raw).decode("latin1")
    sep = text.find("_V")
    if sep == -1:
        return {"type": text.strip(), "firmware_version": ""}
    return {"type": text[:sep].strip(), "firmware_version": text[sep + 2:].strip()}


def build_vendor_access_payload(lq_frame):
    return bytes([VENDOR_SUBOPCODE_DATA]) + bytes(lq_frame)
