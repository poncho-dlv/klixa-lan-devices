# SmallGoGo 2.2.5 — protocole de contrôle des lampes SmallRig

Résultat de la décompilation de `com.zzcyi.bluetoothled` (XAPK 2.2.5), jadx 1.5.1.

---

## 1. Verdict : ce n'est pas du GATT simple, c'est du Bluetooth Mesh

Contrairement à l'hypothèse de départ, l'app n'écrit pas des octets bruts sur une
caractéristique GATT. Elle utilise une **stack Bluetooth Mesh complète** :

| Élément | Valeur |
|---|---|
| SDK mesh | `com.iton.meshlib.rtk` (ITON) au-dessus de `com.realsil.sdk.mesh` (Realtek) |
| Wrapper applicatif | `com.zzcyi.bluetoothled.mesh.FuMeshManager` |
| Company ID | `0x005D` (Realtek Semiconductor) |
| Vendor model serveur | `0x0004005D` (`MESH_MODEL_DATATRANS_SERVER = 262237`) |
| Vendor model client | `0x0005005D` (`MESH_MODEL_DATATRANS_CLIENT = 327773`) |
| Modèle CWRGB serveur | `0x0001005D` (`MESH_MODEL_LIGHT_CWRGB_SERVER = 65629`) |
| Connexion | Mesh **Proxy** (service SIG `0x1828`), `MeshScanner` filtre sur `SERVICE_MESH_PROXY_UUID` |
| Adressage | unicast < `0xC000` (49152) = device ; ≥ `0xC000` = groupe |

Conséquence : pour piloter la lampe il faut la **NetKey**, l'**AppKey**, l'adresse
unicast du nœud, et gérer le chiffrement AES-CCM + les sequence numbers du mesh.

---

## 2. Format des trames applicatives (couche "Lq")

Source : `LqVendorClient.a(int dst, BaseCmd cmd, boolean z)`

```
si cmd.c == true (cas de toutes les commandes de contrôle) :
    [opcode] [len] [xor] [payload…]

si cmd.c == false :
    [opcode] [payload…]

len = longueur du payload
xor = XOR de tous les octets du payload
```

Cette trame est ensuite envoyée comme donnée vendor mesh :

```java
CoreMeshAdapter.meshSendVendorModelData(
    trame,                  // le [opcode][len][xor][payload] ci-dessus
    new byte[]{0x24},       // sous-opcode vendor "data" ('$')
    dstAddr,                // unicast ou groupe
    appKeyIndex,
    MESH_MODEL_DATATRANS_CLIENT
);
```

Autres sous-opcodes vendor observés : `0x30` = getVoltage, `0x33` = getVersion,
`0x28` = heartbeat pub, `0x2A` = setTime.

---

## 3. Table des commandes (classes `com.iton.meshlib.rtk.lq.*`)

| Commande | Opcode | Payload | Plages |
|---|---|---|---|
| `LqCapacity` (lecture batterie) | `0x31` (49) | — | réponse 8 octets ASCII |
| `LqVersion` (lecture firmware) | `0x32` (50) | — | réponse ≥17 octets, split sur `_V` |
| `LqHsi` | `0x33` (51) | `hue>>8, hue, sat, int` | hue 0–360, sat 0–100, int 0–100 |
| `LqCct` | `0x34` (52) | `cct>>8, cct, int, (gm+10)*5` | cct en K, int 0–100, gm –10..+10 |
| `LqFx` | `0x35` (53) | `mode, 5, p1, [p2…]` | longueur variable 3–5 |
| `LqRgbw` | `0x36` (54) | `r, g, b, w` | 0–255 chacun |
| `LqManualCct` | `0x37` (55) | voir classe `b` | modes 1–12 |
| `LqManualHsi` | `0x38` (56) | voir classe `b` | modes 1–12 |
| `LqPickup` | `0x39` (57) | `mode, v>>8, v, int, gm/sat` | mode 1=CCT, 2=HUE |
| `LqLum` (luminosité / on-off) | `0x42` (66) | `val>>8, val` | 0–100, ou `0xFE00` = ON, `0xFC00` = OFF |
| `LqCStatus` (lecture état) | `0x43` (67) | — | réponse `[mode][len][xor][données]` |

### Exemple concret — HSI rouge saturé plein pot

```
payload = 00 00 64 64        (hue=0, sat=100, int=100)
xor     = 00^00^64^64 = 00
trame   = 33 04 00 00 00 64 64
```

### Exemple — CCT 5600 K, intensité 80 %, GM neutre

```
5600 = 0x15E0
payload = 15 E0 50 32        (gm=0 → (0+10)*5 = 50 = 0x32)
xor     = 15^E0^50^32 = 87
trame   = 34 04 87 15 E0 50 32
```

### Exemple — extinction

```
LqLum.OFF = 64512 = 0xFC00
payload = FC 00
xor     = FC
trame   = 42 02 FC FC 00
```

---

## 4. Modes FX (constantes `LqFx`)

Le premier octet du payload est le mode :

| Mode | Valeur | | Mode | Valeur |
|---|---|---|---|---|
| PAPARAZZI | 1 | | FIREWORKS | 8 |
| CYCLE | 2 | | RANDOM | 9 |
| LIGHTNING | 3 | | FIRE | 10 |
| PULSING | 4 | | TV | 11 |
| SOS | 5 | | FAULT_BULB | 12 |
| WELDING | 6 | | | |
| ALARM | 7 | | | |

Sous-variantes : ALARM → 1 = police, 2 = camion de pompiers, 3 = ambulance.
FIRE → 1 = ghost, 2 = tail frame, 3 = bougie.
PULSING → 1 cyan, 2 rose, 3 blanc, 4 jaune, 5 bleu, 6 vert, 7 rouge.
SOS → 1 blanc, 2 jaune, 3 vert, 4 rouge.

Numérotation interne côté device (`MODE_DEV_*`) : RGB 1, PAPARAZZI 2, PARTY 3,
LIGHTNING 4, FAULT_BULB 5, TV 6, CANDLE 7, RANDOM 8, FIREWORKS 9, POLICE 10,
FIRE_TRUCK 11, AMBULANCE 12, WELDING 13, SOS 14, PULSING 15.

---

## 5. Lecture d'état (`LqCStatus`, opcode 0x43)

Réponse : `[mode][len][xor][v1][v2][v3][v4?]`, avec vérification XOR.

| mode | signification | décodage |
|---|---|---|
| 3 | HSI | hue = (v1<<8)+v2, sat = v3, int = v4 |
| 4 | CCT | cct = (v1<<8)+v2, int = v3, gm = v4 – 10 |
| 5 | FX | mode = v1, freq = v2, int = v3 |
| 6 | RGBW | r, g, b, w |
| 7 | MANUAL_CCT | |
| 8 | MANUAL_HSI | |
| 9 | PICKUP | |

`LqCapacity` (0x31) renvoie 8 octets ASCII : batterie sur 3 chiffres, autonomie
sur 3 chiffres (dixièmes), état de charge (0 = déchargé, 1 = en charge, 2 = plein),
et un flag on/off.

---

## 6. Où sont les clés

`MeshNetwork` est sérialisé au **format CDB standard Bluetooth SIG** (Gson,
`@SerializedName("netKeys")` / `"appKeys"`), persisté dans une base Room
(`MeshDb`). L'app expose `exportMeshNetwork()` / `importMeshNetwork(String json)`
via `FuMeshManager` — c'est le chemin le plus court pour récupérer NetKey +
AppKey + adresses unicast sans toucher au firmware.

---

## 7. Pistes d'implémentation

1. **BlueZ `bluetooth-meshd` + D-Bus** sur Linux (Raspberry Pi / mini-PC).
   Provisionner les lampes depuis Python, puis envoyer les messages vendor.
   Le plus propre, mais BlueZ mesh est capricieux à configurer.

2. **Importer le réseau existant.** Exporter le JSON depuis l'app, en extraire
   NetKey/AppKey/unicast, et implémenter uniquement le nécessaire côté Python :
   Proxy PDU + Network layer + Upper Transport (AES-CCM). Faisable mais c'est
   plusieurs centaines de lignes.

3. **Bridge ESP32 (ESP-BLE-MESH).** L'ESP32 fait provisioner + client mesh, et
   expose du HTTP/MQTT vers le PC. C'est de loin le meilleur ratio effort/fiabilité
   pour une intégration stream, et ça règle aussi la question de la portée.

4. **Vérification préalable en 2 minutes** : ouvrir nRF Connect près d'une RM75.
   - Si elle annonce `0x1827` (Mesh Provisioning) ou `0x1828` (Mesh Proxy) → mesh confirmé.
   - Si elle expose le service `00007fd3-…` avec la caractéristique `00007fcb-…`
     (constantes `BleSppGattAttributes` encore présentes dans l'app), il existe
     peut-être un chemin UART/SPP legacy bien plus simple. Les chaînes
     `AT+DATA@0001=` et `AT+DATAX@0001=` trouvées dans `LqVendorClient` vont dans ce sens.
