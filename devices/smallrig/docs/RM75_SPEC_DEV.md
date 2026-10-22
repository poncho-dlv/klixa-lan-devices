# Spécification technique — pilotage des lampes SmallRig RM75

Document d'implémentation pour un client Bluetooth Mesh autonome (Node/TypeScript
ou Python) capable de provisionner et piloter des lampes SmallRig RM75 sans passer
par l'app SmallGoGo.

Sources : décompilation de `com.zzcyi.bluetoothled` 2.2.5 (jadx 1.5.1), spécification
Bluetooth Mesh Profile 1.0.1, observations nRF Connect sur matériel réel.

Les points marqués **[À VÉRIFIER]** sont des inférences non confirmées
empiriquement. Le format Lq décrit au §9 a depuis été confirmé dans SmallGoGo 2.2.5.

> Implémentation compagnon : `src/integrations/smallrig/`. Voir §12 pour l'état des
> vérifications matérielles au moment de l'implémentation initiale.

---

## 1. Vue d'ensemble

La RM75 est un nœud Bluetooth Mesh. Le fabricant réel est Shenzhen Leqi Network
Technology (SmallRig est le distributeur), la stack radio est Realtek. L'hypothèse
initiale plaçait tout sous le Company ID Realtek `0x005D` ; la Composition Data
capturée sur une RM75 réelle (§12 point 4) montre que ce n'est vrai que pour deux
modèles génériques de la stack — le modèle de contrôle Lq est déclaré sous le CID
propre au fabricant.

| Élément | Valeur |
| --- | --- |
| Company ID (CID) du nœud (en-tête Composition Data) | `0x03F6` |
| Vendor model de contrôle (DATATRANS_SERVER, sur la lampe) | `0x100003F6` (ModelID `0x1000`, CID `0x03F6`) |
| Modèles génériques Realtek présents mais non utilisés | `0x0000005D`, `0x0001005D` (CID `0x005D`, stack Realtek) |
| Transport | PB-GATT (provisioning) puis GATT Proxy (contrôle) |
| Rôle à implémenter | Provisioner + Configuration Client + Vendor Client |

Il n'y a **aucune authentification propriétaire** au-dessus du mesh : toute la
sécurité repose sur les clés mesh standard. Une fois provisionnée avec tes clés,
la lampe accepte n'importe quel message correctement chiffré.

### Chaîne complète d'un message de contrôle

```
Commande applicative          →  33 04 00 00 00 64 64
+ opcode data SmallGoGo       →  24 | 33 04 00 00 00 64 64
= Access Payload
  → chiffrement AppKey (AES-CCM, TransMIC 4o)
Upper Transport PDU
  → en-tête SEG/AKF/AID
Lower Transport PDU
  → chiffrement NetKey (AES-CCM) + obfuscation (AES-ECB)
Network PDU
  → en-tête Proxy + segmentation SAR
Proxy PDU
  → GATT Write Without Response sur 0x2ADD
```

---

## 2. Transport GATT

Aucun démon mesh système n'est nécessaire. Tout passe par des caractéristiques
GATT ordinaires — n'importe quelle lib BLE générique suffit
(`@abandonware/noble`, `bleak`, WebBluetooth…).

### Services

| Service | UUID | Data In (Write W/O Resp) | Data Out (Notify) |
|---|---|---|---|
| Mesh Provisioning | `0x1827` | `0x2ADB` | `0x2ADC` |
| Mesh Proxy | `0x1828` | `0x2ADD` | `0x2ADE` |

UUID 128 bits : `00001827-0000-1000-8000-00805F9B34FB` (idem pour les autres, en
substituant le short UUID).

Il faut activer les notifications (écrire `0x0001` sur le CCCD `0x2902`) sur la
caractéristique Data Out avant tout échange.

### Découverte

**Lampe non provisionnée** — annonce le service `0x1827`, avec Service Data :

```
[Device UUID : 16 octets][OOB Information : 2 octets]
```

Le Device UUID est l'identifiant à conserver ; c'est lui qu'on retrouve dans
`ProvisionedNode.getUuid()` côté app.

**Lampe provisionnée** — annonce le service `0x1828`, avec Service Data :

```
[Type : 1 octet][Identifiant]
  Type 0x00 = Network ID  → 8 octets, = k3(NetKey)
  Type 0x01 = Node Identity → 1 octet hash + 8 octets random
```

Sur matériel réel on observe bien `0x1828`, Identification type `0x00`, et un
Network ID de 8 octets. Ce Network ID est public et ne divulgue pas la NetKey,
mais il permet de reconnaître « nos » lampes lors du scan : calcule `k3(NetKey)`
et compare.

### Proxy PDU

Chaque écriture GATT est encapsulée :

```
Octet 0 : [SAR : 2 bits (7-6)][Type : 6 bits (5-0)]
Octets 1+ : données
```

Types :

| Valeur | Signification |
|---|---|
| `0x00` | Network PDU |
| `0x01` | Mesh Beacon |
| `0x02` | Proxy Configuration |
| `0x03` | Provisioning PDU |

SAR :

| Valeur | Signification |
|---|---|
| `0b00` | Message complet |
| `0b01` | Premier segment |
| `0b10` | Segment intermédiaire |
| `0b11` | Dernier segment |

La taille utile par PDU est `ATT_MTU - 1`. Négocie un MTU de 69 minimum ; avec
23 octets par défaut il ne reste que 22 octets utiles et presque tout se
segmente. Les segments doivent être envoyés dans l'ordre et sans entrelacement
avec un autre message.

---

## 3. Primitives cryptographiques

Toutes basées sur AES-128 (ECB) et AES-CMAC.

```
ZERO      = 16 octets à 0x00

s1(M)     = AES-CMAC(ZERO, M)

k1(N, salt, P)
          = AES-CMAC(AES-CMAC(salt, N), P)

k2(N, P)  : T  = AES-CMAC(s1("smk2"), N)
            T1 = AES-CMAC(T,  P || 0x01)
            T2 = AES-CMAC(T, T1 || P || 0x02)
            T3 = AES-CMAC(T, T2 || P || 0x03)
            k2 = (T1 || T2 || T3) mod 2^263
            → NID            = octet 0 de k2, masqué & 0x7F
            → EncryptionKey  = octets 1..16
            → PrivacyKey     = octets 17..32

k3(N)     = AES-CMAC(AES-CMAC(s1("smk3"), N), "id64" || 0x01) mod 2^64
            → Network ID (8 octets)

k4(N)     = AES-CMAC(AES-CMAC(s1("smk4"), N), "id6" || 0x01) mod 2^6
            → AID (6 bits)
```

Dérivations à faire une fois par clé et à mettre en cache :

- Depuis la **NetKey** : `k2(NetKey, 0x00)` → NID, EncryptionKey, PrivacyKey ; et `k3(NetKey)` → Network ID
- Depuis chaque **AppKey** : `k4(AppKey)` → AID
- La **DevKey** de chaque nœud sert pour les messages de configuration (AKF=0)

⚠️ Attention aux implémentations d'AES-CMAC : c'est CMAC (RFC 4493), pas HMAC.
En Node, `node-aes-cmac` ou une implémentation maison au-dessus de `crypto`.

⚠️ Le runtime Electron Windows est lié à BoringSSL et peut ne pas exposer
`aes-128-ccm` dans `node:crypto`, même si le Node/OpenSSL installé sur la machine le
propose. Le compagnon implémente donc le CCM Bluetooth Mesh sans AAD au-dessus du
bloc `aes-128-ecb` (nonce 13 octets, MIC 4/8), avec des vecteurs fixes exécutés aussi
sous Electron et dans le paquet final. Un test uniquement lancé avec `node` ne suffit
pas à valider cette partie du provisioning.

---

## 4. Provisioning (PB-GATT)

Séquence complète, tous les PDU encapsulés en Proxy PDU de type `0x03`.

### Types de PDU

| Code | PDU | Sens |
|---|---|---|
| `0x00` | Invite | Provisioner → Device |
| `0x01` | Capabilities | Device → Provisioner |
| `0x02` | Start | Provisioner → Device |
| `0x03` | Public Key | bidirectionnel |
| `0x04` | Input Complete | Device → Provisioner |
| `0x05` | Confirmation | bidirectionnel |
| `0x06` | Random | bidirectionnel |
| `0x07` | Data | Provisioner → Device |
| `0x08` | Complete | Device → Provisioner |
| `0x09` | Failed | Device → Provisioner |

### Déroulé

```
1.  → Invite        [Attention Duration : 1 octet, ex. 0x00]
2.  ← Capabilities  [11 octets]
3.  → Start         [5 octets]
4.  → Public Key    [64 octets : X || Y]
5.  ← Public Key    [64 octets]
6.  → Confirmation  [16 octets]
7.  ← Confirmation  [16 octets]
8.  → Random        [16 octets]
9.  ← Random        [16 octets]   → vérifier la Confirmation du device ici
10. → Data          [33 octets chiffrés]
11. ← Complete      []
```

**Capabilities (11 octets)** : `NumElements(1) | Algorithms(2) | PublicKeyType(1) |
StaticOOBType(1) | OutputOOBSize(1) | OutputOOBAction(2) | InputOOBSize(1) |
InputOOBAction(2)`.

Conserve `NumElements` : il détermine les adresses unicast à allouer.

**Start (5 octets)** : `Algorithm(1) | PublicKey(1) | AuthenticationMethod(1) |
AuthenticationAction(1) | AuthenticationSize(1)`.

Pour un device sans OOB — cas attendu ici **[À VÉRIFIER via Capabilities]** :
`00 00 00 00 00` (FIPS P-256, pas de clé publique OOB, No OOB auth).
Avec No OOB, `AuthValue` = 16 octets à zéro.

### Dérivations

```
ConfirmationInputs = InvitePDUParams(1)        // le contenu, sans l'octet de type
                   || CapabilitiesPDUParams(11)
                   || StartPDUParams(5)
                   || PublicKeyProvisioner(64)
                   || PublicKeyDevice(64)
                   // total 145 octets

ECDHSecret         = coordonnée X du point ECDH P-256 (32 octets)

ConfirmationSalt   = s1(ConfirmationInputs)
ConfirmationKey    = k1(ECDHSecret, ConfirmationSalt, "prck")
ConfirmationProv   = AES-CMAC(ConfirmationKey, RandomProvisioner || AuthValue)

// après réception de RandomDevice, revérifier :
ConfirmationDevice = AES-CMAC(ConfirmationKey, RandomDevice || AuthValue)
// doit correspondre à la Confirmation reçue à l'étape 7, sinon abandonner

ProvisioningSalt   = s1(ConfirmationSalt || RandomProvisioner || RandomDevice)
SessionKey         = k1(ECDHSecret, ProvisioningSalt, "prsk")
SessionNonce       = k1(ECDHSecret, ProvisioningSalt, "prsn")  // 13 derniers octets
DeviceKey          = k1(ECDHSecret, ProvisioningSalt, "prdk")
```

### Provisioning Data

25 octets en clair :

```
NetworkKey(16) | KeyIndex(2) | Flags(1) | IVIndex(4) | UnicastAddress(2)
```

- `KeyIndex` : index de la NetKey, `0x0000` pour la première
- `Flags` : bit 0 = Key Refresh, bit 1 = IV Update. `0x00` en fonctionnement normal
- `IVIndex` : `0x00000000` pour un réseau neuf
- `UnicastAddress` : adresse du premier élément du nœud

Chiffrement `AES-CCM(SessionKey, SessionNonce, plaintext, MIC 8 octets)` → 33 octets
transmis dans le PDU Data.

### Après le Complete

La connexion GATT bascule : la lampe arrête d'annoncer `0x1827` et se met à
annoncer `0x1828`. Il faut **se déconnecter, rescanner et se reconnecter** sur le
service Proxy. Prévois un délai (la lampe met généralement 1 à 3 secondes).

---

## 5. Couche réseau

### Format du Network PDU

```
IVI(1 bit) | NID(7 bits) | CTL(1 bit) | TTL(7 bits) | SEQ(24 bits)
| SRC(16 bits) | DST(16 bits) | TransportPDU | NetMIC
```

- `IVI` : bit de poids faible de l'IV Index
- `NID` : issu de `k2(NetKey, 0x00)`
- `CTL` : 0 pour les messages d'accès, 1 pour les messages de contrôle
- `TTL` : 5 est une valeur raisonnable ; 0 = pas de relais
- `NetMIC` : 4 octets si CTL=0, 8 octets si CTL=1

### Chiffrement

```
NetworkNonce = 0x00
             || (CTL << 7) | TTL     // 1 octet
             || SEQ                   // 3 octets
             || SRC                   // 2 octets
             || 0x0000                // 2 octets
             || IVIndex               // 4 octets
                                      // total 13 octets

EncDST || EncTransportPDU || NetMIC
  = AES-CCM(EncryptionKey, NetworkNonce, plaintext = DST || TransportPDU, MIC 4)
```

### Obfuscation de l'en-tête

```
PrivacyRandom = 7 premiers octets de (EncDST || EncTransportPDU || NetMIC)

PECB = AES-ECB(PrivacyKey, 0x0000000000 || IVIndex(4) || PrivacyRandom(7))

ObfuscatedHeader = (CTL|TTL, SEQ[0..2], SRC[0..1])  XOR  PECB[0..5]
```

Le PDU final est `(IVI|NID) || ObfuscatedHeader(6) || EncDST || EncTransportPDU || NetMIC`.

Au déchiffrement, on désobfusque d'abord avec le même PECB (l'opération est
symétrique), puis on déchiffre.

---

## 6. Couches transport

### Lower Transport — Access non segmenté

```
Octet 0 : SEG(1 bit, = 0) | AKF(1 bit) | AID(6 bits)
Suite   : Upper Transport PDU (max 15 octets)
```

- `AKF=1` + `AID = k4(AppKey)` pour les messages applicatifs
- `AKF=0` + `AID=0` pour les messages de configuration (DevKey)

15 octets d'Upper Transport = 11 octets d'Access Payload + 4 octets de TransMIC.

### Lower Transport — Access segmenté

Nécessaire dès que l'Access Payload dépasse 11 octets.

```
Octet 0   : SEG(1, = 1) | AKF(1) | AID(6)
Octets 1-3: SZMIC(1 bit) | SeqZero(13 bits) | SegO(5 bits) | SegN(5 bits)
Suite     : 12 octets de segment
```

- `SeqZero` : 13 bits de poids faible du SEQ du premier segment
- `SegO` : index du segment ; `SegN` : index du dernier segment
- `SZMIC` : 0 pour TransMIC 4 octets, 1 pour 8 octets

Les messages segmentés demandent un acquittement (Segment Acknowledgement,
message de contrôle opcode `0x00`) et une logique de retransmission.

**Recommandation** : dimensionne tes commandes pour rester **sous 11 octets
d'Access Payload** et tu évites entièrement la segmentation. Vérifions :

```
24 | 33 04 00 00 00 64 64   → 1 + 7 = 8 octets  ✓
24 | 34 04 87 15 E0 50 32   → 1 + 7 = 8 octets  ✓
24 | 42 02 FC FC 00         → 1 + 5 = 6 octets  ✓
```

Toutes les commandes de contrôle courantes passent en non segmenté. Seuls les
messages de configuration (Composition Data Status notamment) nécessitent le
réassemblage en **réception**. Implémente donc la réception segmentée, mais tu
peux différer l'émission segmentée.

### Upper Transport — Access

```
AppNonce = 0x01
         || (ASZMIC << 7)    // 0x00 en non segmenté
         || SEQ               // 3 octets
         || SRC               // 2 octets
         || DST               // 2 octets
         || IVIndex           // 4 octets

EncAccessPayload || TransMIC
  = AES-CCM(AppKey, AppNonce, AccessPayload, MIC 4)
```

Pour les messages de configuration, le nonce est de type `0x02` (Device nonce),
même structure, et la clé est la **DevKey** du nœud :

```
DeviceNonce = 0x02 || 0x00 || SEQ(3) || SRC(2) || DST(2) || IVIndex(4)
```

---

## 7. Adressage, SEQ et IV Index

### Adresses

| Plage | Type |
|---|---|
| `0x0000` | Non assignée |
| `0x0001` – `0x7FFF` | Unicast |
| `0x8000` – `0xBFFF` | Virtuelle |
| `0xC000` – `0xFFFF` | Groupe |

`0xFFFF` = all-nodes. L'app applique exactement cette règle : un identifiant
`>= 49152` (`0xC000`) est traité comme un groupe, sinon comme un device
(`getNodeTypeByNodeId`).

Le provisioner s'attribue en général `0x0001` et alloue les nœuds à partir de
`0x0002`. Réserve `NumElements` adresses consécutives par nœud.

### Sequence Number — critique

Le SEQ est sur 24 bits, doit **s'incrémenter à chaque message émis** et ne
jamais être réutilisé pour un couple (SRC, IVIndex) donné. Les nœuds appliquent
une protection anti-rejeu : un SEQ inférieur ou égal au dernier vu est
silencieusement ignoré.

**C'est la première cause de « ça marchait, ça ne marche plus » après un
redémarrage.** Persiste le SEQ à chaque incrément, ou par blocs (réserve 100,
persiste, consomme ; au démarrage repars du bloc suivant). La seconde approche
évite une écriture disque par message.

À l'approche de `0xFFFFFF`, il faut déclencher une procédure IV Update. En
pratique, à quelques messages par seconde, ça laisse des mois — mais prévois au
minimum un log d'alerte.

### IV Index

`0x00000000` pour un réseau neuf. Ne bouge que via la procédure IV Update. Tu
peux l'ignorer en v1, mais **persiste-le** avec le reste de l'état réseau.

---

## 8. Configuration après provisioning

Ces messages utilisent la **DevKey** du nœud (AKF=0), destination = adresse
unicast du nœud.

| Opération | Opcode | Rôle |
|---|---|---|
| Composition Data Get | `0x8008` | Lire éléments et modèles du nœud |
| Composition Data Status | `0x02` | Réponse (segmentée, à réassembler) |
| App Key Add | `0x00` | Transmettre l'AppKey au nœud |
| App Key Status | `0x8003` | Réponse |
| Model App Bind | `0x803D` | Lier l'AppKey au vendor model |
| Model App Status | `0x803E` | Réponse |
| Model Subscription Add | `0x801B` | Abonner le modèle à une adresse de groupe |

### Séquence minimale

```
1. Composition Data Get(page 0)
   → vérifier la présence du vendor model 0x100003F6 et noter son élément

2. App Key Add(NetKeyIndex=0, AppKeyIndex=0, AppKey)
   → attendre App Key Status, status 0x00

3. Model App Bind(ElementAddress, AppKeyIndex=0, ModelId=0x100003F6)
   → attendre Model App Status, status 0x00
```

**Sans l'étape 3, la lampe déchiffre correctement tes messages mais les jette**,
faute de modèle lié à cette AppKey. Symptôme typique : aucune erreur, aucune
réaction.

Le `ModelId` d'un vendor model s'encode sur 4 octets, **CID en premier**, le tout
en little-endian : `0x100003F6` → `F6 03 00 10`.

Pour un groupe : `Model Subscription Add(ElementAddress, GroupAddress,
ModelId)` sur chaque lampe, puis émission vers l'adresse de groupe — un seul
message pilote toutes les lampes simultanément, sans dérive visible.

---

## 9. Protocole applicatif Lq

### Format de la trame

Extrait de `LqVendorClient.a(int dst, BaseCmd cmd, boolean z)` :

```
si cmd.c == true  (toutes les commandes de contrôle) :
    [opcode] [len] [xor] [payload…]

si cmd.c == false :
    [opcode] [payload…]

len = longueur du payload
xor = XOR de tous les octets du payload
```

### Préfixe data confirmé

L'app appelle :

```java
CoreMeshAdapter.meshSendVendorModelData(
    trame,                 // [opcode][len][xor][payload]
    new byte[]{0x24},
    dstAddr, appKeyIndex,
    MESH_MODEL_DATATRANS_CLIENT
);
```

et `meshSendVendorModelData` concatène littéralement l'opcode byte[] puis la trame
avant l'appel natif. L'Access Payload utilisé par SmallGoGo est donc :

```
24 | 33 04 00 00 00 64 64
```

La variante historique `E4 5D 00` était une inférence erronée et ne doit plus être
émise. Le fonctionnement radio reste à confirmer sur RM75 réel, mais le format de
l'application Android n'est plus ambigu.

### Table des commandes

Classes `com.iton.meshlib.rtk.lq.*`. Opcodes en hexadécimal (décimal entre
parenthèses, tels qu'ils apparaissent dans le code décompilé).

| Commande | Opcode | Payload | Plages |
|---|---|---|---|
| Capacity (batterie) | `0x31` (49) | — | lecture |
| Version (firmware) | `0x32` (50) | — | lecture |
| HSI | `0x33` (51) | `hue>>8, hue, sat, int` | hue 0–360, sat 0–100, int 0–100 |
| CCT | `0x34` (52) | `cct>>8, cct, int, (gm+10)*5` | cct en K, int 0–100, gm –10..+10 |
| FX | `0x35` (53) | `mode, 5, p1, [p2…]` | longueur 3 à 5 |
| RGBW | `0x36` (54) | `r, g, b, w` | 0–255 chacun |
| Manual CCT | `0x37` (55) | voir §9.4 | modes 1–12 |
| Manual HSI | `0x38` (56) | voir §9.4 | modes 1–12 |
| Pickup | `0x39` (57) | `mode, v>>8, v, int, gm/sat` | mode 1=CCT, 2=HUE |
| Luminance / ON-OFF | `0x42` (66) | `val>>8, val` | 0–100, `0xFE00`=ON, `0xFC00`=OFF |
| Current Status | `0x43` (67) | — | lecture |

Sous-opcodes vendor complémentaires vus dans `VendorClient` : `0x30` getVoltage,
`0x33` getVersion, `0x28` heartbeat publish, `0x2A` setTime.

### Exemples calculés

```
HSI rouge saturé, intensité 100
  payload = 00 00 64 64
  xor     = 00 ^ 00 ^ 64 ^ 64 = 00
  trame   = 33 04 00 00 00 64 64

CCT 5600 K, intensité 80, GM neutre
  5600 = 0x15E0 ; gm=0 → (0+10)*5 = 50 = 0x32
  payload = 15 E0 50 32
  xor     = 15 ^ E0 ^ 50 ^ 32 = 97   (⚠ le document source indique 87 par erreur)
  trame   = 34 04 97 15 E0 50 32

Extinction
  LqLum.OFF = 64512 = 0xFC00
  payload = FC 00
  xor     = FC
  trame   = 42 02 FC FC 00

Allumage
  LqLum.ON = 65024 = 0xFE00
  payload = FE 00
  xor     = FE
  trame   = 42 02 FE FE 00
```

⚠️ `LqLum` sert à la fois de contrôle de luminosité (valeur 0–100) et
d'interrupteur (valeurs sentinelles `0xFE00` / `0xFC00`). La classe clampe entre
0 et 100 **sauf** pour ces deux valeurs.

⚠️ Sur `LqCct`, le canal GM est encodé `(gm + 10) * 5`, donc de 0 à 100 pour une
plage utile de –10 à +10. Le clamp est appliqué avant l'encodage.

### 9.4 Modes FX

Premier octet du payload :

| Mode | Val | Mode | Val |
|---|---|---|---|
| PAPARAZZI | 1 | FIREWORKS | 8 |
| CYCLE | 2 | RANDOM | 9 |
| LIGHTNING | 3 | FIRE | 10 |
| PULSING | 4 | TV | 11 |
| SOS | 5 | FAULT_BULB | 12 |
| WELDING | 6 | | |
| ALARM | 7 | | |

Sous-variantes :

- ALARM → 1 police, 2 camion de pompiers, 3 ambulance
- FIRE → 1 ghost, 2 tail frame, 3 bougie
- PULSING → 1 cyan, 2 rose, 3 blanc, 4 jaune, 5 bleu, 6 vert, 7 rouge
- SOS → 1 blanc, 2 jaune, 3 vert, 4 rouge

Longueur du payload variable selon le mode (`LqFx.a()`) : 5 octets pour les modes
1, 3, 6, 8, 11, 12 ; 4 octets pour les autres. Le second octet est constant à `5`.

Numérotation interne côté firmware, différente (`MODE_DEV_*`, utilisée dans les
retours de statut) : RGB 1, PAPARAZZI 2, PARTY 3, LIGHTNING 4, FAULT_BULB 5,
TV 6, CANDLE 7, RANDOM 8, FIREWORKS 9, POLICE 10, FIRE_TRUCK 11, AMBULANCE 12,
WELDING 13, SOS 14, PULSING 15.

Les commandes Manual CCT / Manual HSI (classe abstraite `b`) exposent des modes
de transition : LUMINANCE 3, LIGHT 4, VACANT 5, FADE_IN 6, FADE_OUT 7, LOOP 8,
COINCIDE_CHANCE 9, COINCIDE_RATE 10, FLASH 11, LOOP_COUNT 12 — avec des courbes
de fade (linéaire, exponentielle, logarithmique, S). Encodage non trivial, à
traiter en v2.

### 9.5 Lecture d'état

**Current Status (`0x43`)** — réponse `[mode][len][xor][v1][v2][v3][v4?]`, avec
vérification XOR sur les `len` octets suivant l'en-tête :

| mode | Type | Décodage |
|---|---|---|
| 3 | HSI | hue = (v1<<8)+v2, sat = v3, int = v4 |
| 4 | CCT | cct = (v1<<8)+v2, int = v3, gm = v4 – 10 |
| 5 | FX | mode = v1, freq = v2, int = v3 |
| 6 | RGBW | r = v1, g = v2, b = v3, w = v4 |
| 7 | MANUAL_CCT | — |
| 8 | MANUAL_HSI | — |
| 9 | PICKUP | — |

**Capacity (`0x31`)** — 8 octets, encodés en **chiffres ASCII** (le décodeur fait
`Integer.parseInt` sur chaque caractère) :

```
octets 0-2 : batterie, centaines / dizaines / unités  → %
octets 3-5 : autonomie, dizaines / unités / dixièmes  → heures
octet    6 : 0 = non chargé, 1 = en charge, 2 = plein
octet    7 : 1 = allumée
```

**Version (`0x32`)** — chaîne ASCII d'au moins 17 octets, découpée sur `_V` :
avant = type, après = version firmware.

Les réponses arrivent en notification sur `0x2ADE` et remontent toute la pile.
Note qu'elles peuvent être préfixées par `AT+DATA@0001=` ou `AT+DATAX@0001=` —
l'app cherche ces marqueurs et tronque avant. Prévois le cas.

---

## 10. Reconnexion et robustesse

- Une lampe hors de portée ou éteinte ne casse pas le réseau ; les autres restent
  pilotables si l'une d'elles sert de proxy.
- Après reconnexion GATT, réactive les notifications sur `0x2ADE`.
- Le Proxy Filter (Proxy Configuration, type `0x02`) permet de limiter le trafic
  remontant. Optionnel, mais utile si tu as beaucoup de nœuds.
- Persiste **impérativement** : NetKey, AppKey, IV Index, SEQ, et pour chaque nœud
  DevKey + adresse unicast + Device UUID + nombre d'éléments.
- Format recommandé : le **Mesh Configuration Database (CDB)** JSON du SIG. C'est
  celui qu'utilise l'app (Gson, champs `netKeys` / `appKeys` / `nodes`), c'est
  celui qu'exporte nRF Mesh, et ça te donne l'interopérabilité gratuitement.

---

## 11. Ordre d'implémentation conseillé

1. **Primitives crypto** (s1, k1, k2, k3, k4, AES-CCM) validées sur les vecteurs
   de test de l'annexe 8 de la spec Mesh Profile. Ne passe pas à la suite tant
   que ça ne passe pas — tout le reste en dépend.
2. **Transport GATT** : scan, connexion, notifications, segmentation SAR.
3. **Provisioning** PB-GATT.
4. **Couche réseau** : chiffrement, obfuscation, SEQ.
5. **Lower/Upper transport** non segmenté en émission, réassemblage en réception.
6. **Configuration** : Composition Data Get, App Key Add, Model App Bind.
7. **Protocole Lq** — trivial une fois les 6 étapes précédentes en place.

L'étape 1 est la seule testable sans matériel, et c'est aussi celle où les bugs
sont les plus coûteux à diagnostiquer plus tard. Prends le temps.

---

## 12. Récapitulatif des points à vérifier

| # | Point | Impact | Comment vérifier | État côté implémentation compagnon |
|---|---|---|---|---|
| 1 | Préfixe data Lq (§9) | Moyen | Capture radio RM75 | `[0x24][trame Lq]` confirmé dans SmallGoGo 2.2.5 ; validation radio encore requise |
| 2 | Méthode d'authentification OOB | Moyen | Lire les Capabilities lors du provisioning | Capabilities validées puis No OOB explicite ; aucune protection MITM revendiquée |
| 3 | Nombre d'éléments du nœud | Faible | Capabilities + Composition Data | Alloué dynamiquement depuis les Capabilities reçues |
| 4 | Présence du vendor model `0x100003F6` | Moyen | Composition Data Get page 0 | Corrigé après capture radio réelle (hypothèse initiale `0x0004005D` erronée) ; vérifiée strictement, bind et commandes ciblent l'élément qui le porte |
| 5 | Longueurs exactes des payloads FX | Faible | Test empirique par mode | Formats confirmés dans `LqFx` de SmallGoGo ; validation radio encore requise |

Les échanges GATT, le filtre Proxy et les temporisations doivent encore être validés
sur lampe réelle malgré les tests déterministes du compagnon.
