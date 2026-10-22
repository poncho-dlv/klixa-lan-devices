"""Provisioning PB-GATT, rôle Provisioner : Invite -> Capabilities -> Start -> Public Key -> Confirmation ->
Random -> Data -> Complete, avec les dérivations cryptographiques associées. Le transport est injecté
(`send(type, params)` / `receive(expected_type)`), ce qui permet de tester avec un appareil simulé."""
from .crypto import (aes_ccm_decrypt, aes_ccm_encrypt, aes_cmac, compute_shared_secret,
                     generate_provisioning_key_pair, k1, random_bytes, s1)

INVITE, CAPABILITIES, START, PUBLIC_KEY, INPUT_COMPLETE = 0x00, 0x01, 0x02, 0x03, 0x04
CONFIRMATION, RANDOM, DATA, COMPLETE, FAILED = 0x05, 0x06, 0x07, 0x08, 0x09

# La RM75 n'a pas démontré de canal OOB exploitable : No-OOB protège l'intégrité de l'échange mais PAS
# contre un MITM actif.
NO_OOB_AUTH_VALUE = bytes(16)


def encode_invite(attention_duration_s=0):
    return bytes([attention_duration_s & 0xFF])


def decode_capabilities(data):
    data = bytes(data)
    if len(data) < 11:
        raise ValueError("Capabilities PDU trop court")
    return {"num_elements": data[0], "algorithms": (data[1] << 8) | data[2], "public_key_type": data[3],
            "static_oob_type": data[4], "output_oob_size": data[5], "output_oob_action": (data[6] << 8) | data[7],
            "input_oob_size": data[8], "input_oob_action": (data[9] << 8) | data[10]}


def validate_no_oob_capabilities(capabilities):
    if capabilities["num_elements"] < 1:
        raise ValueError("Capabilities invalides : le device doit annoncer au moins un élément")
    if (capabilities["algorithms"] & 0x0001) == 0:
        raise ValueError("Capabilities incompatibles : FIPS P-256 non supporté")
    for size_key, action_key in (("output_oob_size", "output_oob_action"), ("input_oob_size", "input_oob_action")):
        if capabilities[size_key] > 8:
            raise ValueError("Capabilities invalides : taille OOB hors plage")
        if capabilities[size_key] == 0 and capabilities[action_key] != 0:
            raise ValueError("Capabilities invalides : actions OOB sans taille associée")
    return capabilities


def encode_start(algorithm=0, public_key_type=0, auth_method=0, auth_action=0, auth_size=0):
    return bytes([algorithm, public_key_type, auth_method, auth_action, auth_size])


def encode_provisioning_data_plaintext(net_key, unicast_address, key_index=0, flags=0, iv_index=0):
    return (bytes(net_key) + key_index.to_bytes(2, "big") + bytes([flags]) + iv_index.to_bytes(4, "big")
            + unicast_address.to_bytes(2, "big"))


def decode_provisioning_data_plaintext(data):
    data = bytes(data)
    return {"net_key": data[:16], "key_index": int.from_bytes(data[16:18], "big"), "flags": data[18],
            "iv_index": int.from_bytes(data[19:23], "big"), "unicast_address": int.from_bytes(data[23:25], "big")}


async def run_provisioning(*, transport, net_key, unicast_address, key_index=0, iv_index=0, attention_duration_s=0,
                           on_before_data=None):
    """Exécute le rôle Provisioner. `unicast_address` : entier ou fonction `(capabilities) -> int` (le nombre
    d'éléments, donc la taille du bloc d'adresses, n'est connu qu'à la réception des Capabilities).

    En cas d'erreur, l'exception porte `provisioning_data_may_have_been_sent` : avant le premier `send(DATA)`
    la lampe ne peut pas avoir reçu les clés ; ensuite une erreur reste incertaine."""
    data_may_have_been_sent = False
    try:
        invite = encode_invite(attention_duration_s)
        await transport.send(INVITE, invite)
        capabilities_raw = await transport.receive(CAPABILITIES)
        capabilities = validate_no_oob_capabilities(decode_capabilities(capabilities_raw))
        resolved_address = unicast_address(capabilities) if callable(unicast_address) else unicast_address

        start = encode_start()
        await transport.send(START, start)

        private, provisioner_public = generate_provisioning_key_pair()
        await transport.send(PUBLIC_KEY, provisioner_public)
        device_public = await transport.receive(PUBLIC_KEY)
        ecdh_secret = compute_shared_secret(private, device_public)

        confirmation_salt = s1(invite + capabilities_raw + start + provisioner_public + bytes(device_public))
        confirmation_key = k1(ecdh_secret, confirmation_salt, b"prck")

        random_provisioner = random_bytes(16)
        await transport.send(CONFIRMATION, aes_cmac(confirmation_key, random_provisioner + NO_OOB_AUTH_VALUE))
        confirmation_received = await transport.receive(CONFIRMATION)

        await transport.send(RANDOM, random_provisioner)
        random_device = bytes(await transport.receive(RANDOM))

        expected = aes_cmac(confirmation_key, random_device + NO_OOB_AUTH_VALUE)
        if expected != bytes(confirmation_received):
            raise ValueError("Confirmation cryptographique du device invalide — abandon du provisioning")

        provisioning_salt = s1(confirmation_salt + random_provisioner + random_device)
        session_key = k1(ecdh_secret, provisioning_salt, b"prsk")
        session_nonce = k1(ecdh_secret, provisioning_salt, b"prsn")[-13:]
        device_key = k1(ecdh_secret, provisioning_salt, b"prdk")

        # Préparer entièrement le PDU chiffré AVANT de journaliser la DevKey, puis journal durable, puis send(DATA).
        plaintext = encode_provisioning_data_plaintext(net_key, resolved_address, key_index, 0, iv_index)
        ciphertext, mic = aes_ccm_encrypt(session_key, session_nonce, plaintext, 8)

        result = {"device_key": device_key, "unicast_address": resolved_address,
                  "num_elements": capabilities["num_elements"], "capabilities": capabilities,
                  "authentication_method": "no-oob", "authentication_mitm_protected": False}
        if on_before_data:
            await on_before_data(result)

        data_may_have_been_sent = True
        await transport.send(DATA, ciphertext + mic)
        await transport.receive(COMPLETE)
        return result
    except Exception as error:
        if not hasattr(error, "provisioning_data_may_have_been_sent"):
            try:
                error.provisioning_data_may_have_been_sent = data_may_have_been_sent
            except AttributeError:
                pass
        raise


async def simulate_device_side(*, transport, capabilities):
    """Côté appareil (tests uniquement : la RM75 implémente ce rôle dans son firmware)."""
    invite = await transport.receive(INVITE)
    capabilities_raw = bytes([capabilities["num_elements"], (capabilities["algorithms"] >> 8) & 0xFF,
                              capabilities["algorithms"] & 0xFF, capabilities["public_key_type"],
                              capabilities["static_oob_type"], capabilities["output_oob_size"],
                              (capabilities["output_oob_action"] >> 8) & 0xFF, capabilities["output_oob_action"] & 0xFF,
                              capabilities["input_oob_size"], (capabilities["input_oob_action"] >> 8) & 0xFF,
                              capabilities["input_oob_action"] & 0xFF])
    await transport.send(CAPABILITIES, capabilities_raw)
    start = await transport.receive(START)

    private, device_public = generate_provisioning_key_pair()
    provisioner_public = bytes(await transport.receive(PUBLIC_KEY))
    await transport.send(PUBLIC_KEY, device_public)

    ecdh_secret = compute_shared_secret(private, provisioner_public)
    confirmation_salt = s1(bytes(invite) + capabilities_raw + bytes(start) + provisioner_public + device_public)
    confirmation_key = k1(ecdh_secret, confirmation_salt, b"prck")

    confirmation_received = bytes(await transport.receive(CONFIRMATION))
    random_device = random_bytes(16)
    await transport.send(CONFIRMATION, aes_cmac(confirmation_key, random_device + NO_OOB_AUTH_VALUE))

    random_provisioner = bytes(await transport.receive(RANDOM))
    if aes_cmac(confirmation_key, random_provisioner + NO_OOB_AUTH_VALUE) != confirmation_received:
        raise ValueError("Confirmation du provisioner invalide (simulation)")
    await transport.send(RANDOM, random_device)

    provisioning_salt = s1(confirmation_salt + random_provisioner + random_device)
    session_key = k1(ecdh_secret, provisioning_salt, b"prsk")
    session_nonce = k1(ecdh_secret, provisioning_salt, b"prsn")[-13:]
    device_key = k1(ecdh_secret, provisioning_salt, b"prdk")

    data = bytes(await transport.receive(DATA))
    plaintext = aes_ccm_decrypt(session_key, session_nonce, data[:-8], data[-8:], 8)
    await transport.send(COMPLETE, b"")
    return {"device_key": device_key, "provisioning_data": decode_provisioning_data_plaintext(plaintext)}
