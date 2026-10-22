// Liaison matérielle Bluetooth LE réelle, via la lib `webbluetooth` (implémentation
// Node de l'API Web Bluetooth, adaptateur natif SimpleBLE — prébuilts win32/linux/
// darwin x64+arm64, cf. package.json). Isolé du reste du code (crypto/network/
// transport/provisioning/proxy-pdu sont tous purs et testés sans matériel) : c'est ICI
// et uniquement ici que ce module dépend d'un vrai adaptateur Bluetooth actif sur la
// machine qui exécute le compagnon.
//
// [NON TESTABLE EN CI — nécessite du matériel réel] Les transitions et erreurs sont
// simulées par tests, et l'API est vérifiée contre le paquet natif installé. La
// validation finale du correctif GATT reste à effectuer avec une RM75 physique.

import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('smallrig-ble');
const SCAN_WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ble-scan-worker.js');
const SESSION_WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ble-session-worker.js');
// Marge laissée au processus enfant au-delà du timeout de scan demandé, avant de
// considérer qu'il est bloqué et de le tuer de force (cf. scanForLampAdvertisements).
const SCAN_WORKER_KILL_GRACE_MS = 5000;
const SESSION_OPEN_TIMEOUT_MS = 50000;
const SESSION_WRITE_TIMEOUT_MS = 15000;
const SESSION_CLOSE_TIMEOUT_MS = 8000;

export const GATT = {
  PROVISIONING_SERVICE: 0x1827,
  PROVISIONING_DATA_IN: 0x2adb,
  PROVISIONING_DATA_OUT: 0x2adc,
  PROXY_SERVICE: 0x1828,
  PROXY_DATA_IN: 0x2add,
  PROXY_DATA_OUT: 0x2ade
};

// Taille utile par écriture GATT par défaut (MTU 23 legacy - 3 octets d'en-tête ATT).
// webbluetooth n'expose pas le MTU négocié post-connexion ; rester sur cette valeur
// conservatrice est sans risque, la segmentation Proxy PDU (proxy-pdu.js) absorbe la
// différence si le MTU réel est plus grand (juste plus de fragments que nécessaire).
export const DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 20;

function serviceUuidString(shortUuid) {
  return `0000${shortUuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

function toBuffer(dataView) {
  return Buffer.from(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

// SimpleBLE fusionne les Service Data vus pendant un même scan. Si une lampe passe
// de 0x1827 à 0x1828 dans cette fenêtre, les deux clés peuvent donc coexister. Le
// provisioning est à sens unique : dans ce cas ambigu, 0x1828 est l'état le plus
// récent possible et doit primer sur l'ancien 0x1827.
export function parseLampAdvertisement(device) {
  const adData = device._adData;
  const serviceData = adData?.serviceData;
  if (!serviceData) return null;

  const provisioned = serviceData.get(serviceUuidString(GATT.PROXY_SERVICE));
  if (provisioned && provisioned.byteLength >= 1) {
    const buf = toBuffer(provisioned);
    const isNetworkId = buf[0] === 0x00 && buf.length >= 9;
    return {
      bleDeviceId: device.id,
      device,
      kind: 'provisioned',
      networkId: isNetworkId ? buf.subarray(1, 9) : null,
      rssi: adData.rssi,
      name: device.name || null
    };
  }

  const unprovisioned = serviceData.get(serviceUuidString(GATT.PROVISIONING_SERVICE));
  if (unprovisioned && unprovisioned.byteLength >= 16) {
    return {
      bleDeviceId: device.id,
      device,
      kind: 'unprovisioned',
      deviceUuid: toBuffer(unprovisioned).subarray(0, 16),
      rssi: adData.rssi,
      name: device.name || null
    };
  }

  return null;
}

// Scanne les lampes RM75 à proximité (provisionnées ou non) en lisant les Service Data
// publicitaires — sans jamais se connecter (§2 "Découverte"). `deviceFound` ne
// sélectionne jamais un device (retourne toujours false) : on veut TOUS les résultats,
// pas le premier device trouvé.
//
// ATTENTION — piège de l'API `webbluetooth` : `requestDevice()` a son propre timeout
// interne, mais celui-ci ne rejette QUE si aucun device n'a jamais été vu
// (`if (!found) reject(...)`- cf. node_modules/webbluetooth/src/bluetooth.ts). Dès
// qu'un seul device correspond (même sans qu'on le "sélectionne" via `selectFn`),
// `found` passe à `true` et cette clause de rejet devient un no-op — et comme on ne
// sélectionne jamais rien, la promesse ne se résout JAMAIS non plus. Résultat :
// `await bt.requestDevice(...)` reste bloqué indéfiniment dès qu'AU MOINS UN appareil
// Bluetooth quelconque est à proximité (donc presque toujours en pratique). Vérifié
// empiriquement : gérer nous-mêmes la durée du scan (timer + `cancelRequest()`) sans
// jamais attendre la résolution de `requestDevice()` résout complètement le problème.
//
// Implémentation IN-PROCESS : sur certaines machines, l'appel natif sous-jacent
// (SimpleBLE -> WinRT) peut aussi se bloquer durablement côté natif (observé en
// production : CPU bas, aucune réponse) — distinct du piège ci-dessus, mais avec le
// même symptôme. Cette fonction reste utilisée telle quelle par provision()/
// reconnexion (qui ont besoin d'un handle `device` réel, non sérialisable entre
// processus) ; l'écran "Scanner" de l'UI passe par `scanForLampAdvertisements`
// ci-dessous, qui isole cet appel dans un processus séparé avec un timeout dur — voir
// ble-scan-worker.js pour le pourquoi.
// `stopWhen` (optionnel) : prédicat appelé sur chaque annonce de lampe parsée — s'il
// retourne true, le scan s'arrête immédiatement au lieu d'attendre la fin de la
// fenêtre `timeoutMs` (qui n'est alors qu'un plafond). Utilisé par le worker de
// session Proxy pour se reconnecter à une cible déjà connue sans payer les 8 s
// pleines du scan à chaque coupure GATT. Le prédicat ne reçoit que des annonces
// COMPLÈTES (parseLampAdvertisement a déjà exigé les Service Data exploitables) ;
// l'arrêt passe par le même `cancelRequest()` que le chemin nominal, la contrainte
// « jamais scan + connect concurrents » (SimpleBLE/WinRT) reste respectée.
export async function scanForLampAdvertisementsInProcess({ timeoutMs = 6000, adapterIndex, stopWhen } = {}) {
  // Import volontairement local. En desktop, ce module est aussi chargé par le
  // processus principal Electron : charger l'addon SimpleBLE à ce niveau y ferait
  // exécuter ses appels WinRT synchrones sur le thread UI/COM STA. Cette fonction
  // n'est appelée que dans les workers Node dédiés (scan/session) ou les diagnostics.
  const { Bluetooth, getAdapters } = await import('webbluetooth');
  const found = new Map();
  const availableAdapters = getAdapters();
  const selectedAdapter = typeof adapterIndex === 'number'
    ? { index: adapterIndex }
    : availableAdapters.find((adapter) => adapter.active) || availableAdapters[0];
  if (!selectedAdapter) throw new Error('Aucun adaptateur Bluetooth disponible');

  let stopRequested = false;
  let resolveScanWait = null;
  const requestEarlyStop = () => {
    stopRequested = true;
    resolveScanWait?.();
  };

  const bt = new Bluetooth({
    // Large marge côté lib : on n'attend jamais son propre timeout (cf. ci-dessus),
    // c'est notre `setTimeout` + `cancelRequest()` plus bas qui pilote la durée réelle.
    scanTime: Math.max(1, timeoutMs / 1000) + 30,
    // Toujours re-sélectionner l'index : le patch webbluetooth reconstruit ainsi un
    // AdapterBase natif et purge son cache Service Data avant chaque nouveau scan.
    adapterIndex: selectedAdapter.index,
    deviceFound: (device) => {
      const advertisement = parseLampAdvertisement(device);
      if (advertisement) {
        found.set(device.id, advertisement);
        if (stopWhen && !stopRequested) {
          try {
            if (stopWhen(advertisement)) requestEarlyStop();
          } catch { /* prédicat best-effort : ne jamais casser le scan */ }
        }
      }
      return false;
    }
  });

  // acceptAllDevices, PAS filters : un filtre multi-services sur Windows (WinRT
  // BluetoothLEAdvertisementWatcher) exige que TOUTES les UUID listées soient
  // présentes SIMULTANÉMENT dans une même annonce (ET, pas OU) — vérifié
  // empiriquement sur matériel réel. Une lampe n'annonce jamais 0x1827 et 0x1828 en
  // même temps (provisionnée OU non), donc `filters: [{services:[0x1827]},
  // {services:[0x1828]}]` ne matchait jamais rien, silencieusement. Le tri
  // unprovisionné/provisionné se fait déjà nous-mêmes dans `deviceFound` ci-dessus via
  // les Service Data, donc `acceptAllDevices` + filtrage manuel est correct et sans
  // perte.
  //
  // Fire-and-forget délibéré : on n'attend JAMAIS cette promesse (cf. commentaire de
  // fonction ci-dessus — elle ne se résout jamais dès qu'un device est vu). On stoppe
  // nous-mêmes le scan après `timeoutMs` via `cancelRequest()`, sans lien avec le
  // timeout interne de la lib.
  let scanError = null;
  bt.requestDevice({ acceptAllDevices: true }).catch((err) => {
    if (!/no devices found/i.test(String(err))) {
      scanError = err instanceof Error ? err : new Error(String(err));
      log.warn('Scan BLE (arrière-plan) terminé en erreur', scanError.message);
    }
  });

  await new Promise((resolve) => {
    if (stopRequested) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    // clearTimeout à la résolution anticipée : timer inoffensif sinon, mais autant ne
    // pas laisser traîner un handle dans un worker à durée de vie courte.
    resolveScanWait = () => { clearTimeout(timer); resolve(); };
  });
  try {
    await bt.cancelRequest();
  } catch (err) {
    // Ne jamais rendre un handle au code de connexion si l'arrêt natif du scan n'a
    // pas été confirmé : SimpleBLE/WinRT ne fiabilise pas scan + connect concurrents.
    throw new Error(`Impossible d'arrêter le scan BLE avant connexion : ${err?.message || String(err)}`, { cause: err });
  }
  if (scanError) {
    throw new Error(`Scan Bluetooth impossible : ${scanError.message}`, { cause: scanError });
  }

  return [...found.values()];
}

// Scan d'affichage (bouton "Scanner" de l'UI / commande `smallrig.discover`), isolé
// dans un processus enfant dédié avec un timeout DUR (kill forcé). Un timeout côté JS
// dans CE process (Promise.race, setTimeout) ne suffirait pas : si l'appel natif
// bloque la boucle d'événements du process principal, plus rien ne s'y exécute — y
// compris les timers — et tout le compagnon (Hue/OBS/Streamer.bot inclus) resterait
// figé avec lui. En isolant l'appel, seul ce processus enfant peut se bloquer ; le
// process principal reste réactif et peut le tuer de force s'il ne répond pas à temps.
// Retourne des champs simples (deviceUuid/networkId en hex string) et un sélecteur
// sérialisable. Le handle natif ne traverse jamais l'IPC : le worker de session
// rescannera ce sélecteur avant d'ouvrir GATT.
//
// En pratique (testé sur cette machine avec un dongle Bluetooth réel), l'appel natif
// sous-jacent (SimpleBLE/WinRT) reste parfois bloqué de façon intermittente — pas à
// chaque scan, mais assez souvent pour être gênant. Comme un nouvel essai réussit
// généralement, on retente une fois automatiquement avant de remonter une erreur à
// l'utilisateur (double la latence dans le pire cas, mais évite un aller-retour manuel
// pour la plupart des échecs).
export async function scanForLampAdvertisements({ timeoutMs = 6000 } = {}) {
  try {
    return await scanOnceIsolated({ timeoutMs });
  } catch (err) {
    log.warn('Premier essai de scan BLE échoué, nouvelle tentative', err.message);
    // Un SIGKILL en plein appel natif ne laisse pas au processus la chance de
    // libérer proprement le radio Bluetooth côté OS ; un court délai avant de
    // retenter réduit le risque d'enchaîner sur un second échec pour la même raison.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return scanOnceIsolated({ timeoutMs });
  }
}

function normalizeHexIdentity(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return Buffer.from(value).toString('hex');
  return String(value).trim().toLowerCase() || null;
}

function attachBrokerSelectors(lamps) {
  return (lamps || []).map((lamp) => ({
    ...lamp,
    // Objet volontairement sérialisable : ce n'est PAS le BluetoothDevice natif du
    // worker de scan. open*Connection l'utilise pour faire rescanner puis connecter
    // la cible dans un nouveau worker qui conserve, lui, le vrai handle GATT.
    device: {
      bleDeviceId: lamp.bleDeviceId,
      kind: lamp.kind,
      deviceUuid: normalizeHexIdentity(lamp.deviceUuid),
      networkId: normalizeHexIdentity(lamp.networkId)
    }
  }));
}

async function scanOnceIsolated({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimeout;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      child.removeAllListeners();
      try { child.kill(); } catch { /* déjà arrêté */ }
      fn(value);
    };

    const child = fork(SCAN_WORKER_PATH, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true
    });

    hardTimeout = setTimeout(() => {
      log.warn('Scan BLE : le processus de scan ne répond pas, arrêt forcé', { timeoutMs });
      try { child.kill('SIGKILL'); } catch { /* déjà arrêté */ }
      finish(reject, new Error(
        'Le scan Bluetooth ne répond pas (adaptateur bloqué ou indisponible). '
        + 'Vérifie que le Bluetooth est bien activé, puis réessaie ; si ça persiste, redémarre le compagnon.'
      ));
    }, timeoutMs + SCAN_WORKER_KILL_GRACE_MS);

    child.on('message', (msg) => {
      if (!msg || msg.type !== 'result') return;
      if (msg.ok) finish(resolve, attachBrokerSelectors(msg.lamps));
      else finish(reject, new Error(msg.error));
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`Le processus de scan Bluetooth s'est arrêté de manière inattendue (code ${code})`));
    });

    child.send({ type: 'scan', timeoutMs });
  });
}

// Ouvre une connexion GATT vers un device déjà repéré par scanForLampAdvertisements
// (ou par un scan ciblé équivalent), sur le service Provisioning (0x1827) ou Proxy
// (0x1828), avec notifications actives sur la caractéristique Data Out.
export async function openGattConnection(device, { serviceUuid, dataInUuid, dataOutUuid, onData, maxAttributeValueLength = DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH }) {
  // Un seul essai par handle : le mesh-client pilote les retries et refait un scan
  // avant chacun. Empiler ici des retries sur un handle SimpleBLE possiblement périmé
  // créait jusqu'à neuf connexions et plusieurs déconnexions concurrentes.
  let phase = 'connexion au périphérique';
  let service;
  let dataIn;
  let dataOut;
  let listener;
  let listenerAttached = false;
  let notificationsStarted = false;

  try {
    const server = await device.gatt.connect();

    phase = `découverte du service 0x${serviceUuid.toString(16)}`;
    service = await server.getPrimaryService(serviceUuidString(serviceUuid));

    phase = `découverte de Data In 0x${dataInUuid.toString(16)}`;
    dataIn = await service.getCharacteristic(serviceUuidString(dataInUuid));

    phase = `découverte de Data Out 0x${dataOutUuid.toString(16)}`;
    dataOut = await service.getCharacteristic(serviceUuidString(dataOutUuid));

    listener = () => {
      const view = dataOut.value;
      if (!view) return;
      try {
        onData?.(toBuffer(view));
      } catch (error) {
        // Une notification radio mal formée ne doit pas devenir une exception globale
        // capable d'arrêter tout Electron. La transaction en cours expirera proprement.
        log.warn('Notification GATT SmallRig ignorée', error?.message || String(error));
      }
    };
    dataOut.addEventListener('characteristicvaluechanged', listener);
    listenerAttached = true;

    phase = 'activation des notifications';
    notificationsStarted = true;
    await dataOut.startNotifications();
  } catch (err) {
    // Une erreur de connexion peut quand même laisser WinRT connecté. Effectuer un
    // unique nettoyage ici, y compris si la couche Web Bluetooth se croit fermée.
    const cleanupErrors = [];
    if (notificationsStarted) {
      try {
        await dataOut.stopNotifications();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (listenerAttached) {
      try {
        dataOut.removeEventListener('characteristicvaluechanged', listener);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await device.gatt.disconnect();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    const nativeMessage = err?.message || String(err);
    const cleanupMessage = cleanupErrors.length > 0
      ? `; nettoyage GATT en erreur : ${cleanupErrors.map((error) => error?.message || String(error)).join(' | ')}`
      : '';
    const wrapped = new Error(
      `Ouverture GATT 0x${serviceUuid.toString(16)} échouée pendant ${phase} : ${nativeMessage}${cleanupMessage}`,
      { cause: err }
    );
    wrapped.code = err?.code || 'SMALLRIG_GATT_OPEN_FAILED';
    if (err?.nativeDiagnostics !== undefined) wrapped.nativeDiagnostics = err.nativeDiagnostics;
    if (cleanupErrors.length > 0) wrapped.cleanupErrors = cleanupErrors;
    throw wrapped;
  }

  let closed = false;
  return {
    maxAttributeValueLength,
    async write(buffer) {
      if (closed) throw new Error('Connexion GATT fermée');
      // webbluetooth construit un DataView sur `buffer.buffer` SANS tenir compte de
      // byteOffset/byteLength (cf. characteristic.js#writeValue : `new
      // DataView(arrayBuffer)` sans les 2e/3e arguments). Un Buffer Node partage
      // souvent un ArrayBuffer sous-jacent plus grand (pool interne, Buffer.concat,
      // subarray…) : envoyer `buffer` tel quel peut donc écrire un payload gonflé
      // d'octets parasites, bien au-delà de la trame voulue — provoque un échec natif
      // ("Write failed"), vérifié empiriquement sur matériel réel. On copie donc vers
      // un Uint8Array/ArrayBuffer neuf, de taille exacte, avant chaque écriture.
      const exact = new Uint8Array(buffer.byteLength);
      exact.set(buffer);
      await dataIn.writeValueWithoutResponse(exact);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (notificationsStarted) {
        try {
          await dataOut.stopNotifications();
        } catch (err) {
          log.warn('Erreur à l’arrêt des notifications GATT', err?.message || String(err));
        }
        notificationsStarted = false;
      }
      try {
        dataOut.removeEventListener('characteristicvaluechanged', listener);
      } catch (err) {
        log.warn('Erreur au retrait des notifications GATT', err?.message || String(err));
      }
      if (!device.gatt.connected) return;
      try {
        await device.gatt.disconnect();
      } catch (err) {
        log.warn('Erreur à la déconnexion GATT', err?.message || String(err));
      }
    },
    get connected() {
      return !closed && device.gatt.connected;
    }
  };
}

function deserializeWorkerError(serialized, fallbackMessage) {
  const error = new Error(serialized?.message || fallbackMessage);
  if (serialized?.code) error.code = serialized.code;
  if (serialized?.nativeDiagnostics !== undefined) error.nativeDiagnostics = serialized.nativeDiagnostics;
  if (serialized?.phase) error.phase = serialized.phase;
  if (serialized?.stack) error.workerStack = serialized.stack;
  return error;
}

// Lance un processus Node dédié qui possède l'adaptateur, le BluetoothDevice et la
// connexion GATT pendant toute la session. Aucun appel webbluetooth/SimpleBLE/WinRT
// n'est ainsi exécuté dans le processus principal Electron (COM STA + thread UI).
// Le timeout est réellement dur : si WinRT reste bloqué dans un appel synchrone, le
// parent peut tuer uniquement ce worker et continuer à servir le reste du compagnon.
export async function openBrokeredGattConnection(mode, selector, {
  onData,
  scanTimeoutMs = 8000,
  openTimeoutMs = SESSION_OPEN_TIMEOUT_MS,
  writeTimeoutMs = SESSION_WRITE_TIMEOUT_MS,
  closeTimeoutMs = SESSION_CLOSE_TIMEOUT_MS,
  forkProcess = fork
} = {}) {
  if (mode !== 'provisioning' && mode !== 'proxy') throw new Error(`Mode GATT SmallRig invalide : ${mode}`);

  const child = forkProcess(SESSION_WORKER_PATH, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  });
  const pending = new Map();
  let nextRequestId = 1;
  let connected = false;
  let terminated = false;

  const terminate = () => {
    if (terminated) return;
    terminated = true;
    try { child.kill('SIGKILL'); } catch { /* processus déjà arrêté */ }
  };

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const failWorker = (error) => {
    connected = false;
    rejectPending(error);
  };

  child.on('message', (message) => {
    if (!message) return;
    if (message.type === 'notification') {
      try {
        onData?.(Buffer.from(message.data || '', 'base64'));
      } catch (error) {
        log.warn('Notification du worker BLE SmallRig ignorée', error?.message || String(error));
      }
      return;
    }
    if (message.type !== 'response') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(deserializeWorkerError(message.error, `Échec du worker BLE (${request.operation})`));
  });
  child.on('error', (error) => {
    failWorker(new Error(`Worker BLE SmallRig indisponible : ${error.message}`, { cause: error }));
    terminate();
  });
  child.on('exit', (code, signal) => {
    connected = false;
    terminated = true;
    if (pending.size > 0) {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      const error = new Error(`Le worker BLE SmallRig s'est arrêté pendant une opération (${detail})`);
      error.code = 'SMALLRIG_BLE_WORKER_EXITED';
      failWorker(error);
    }
  });

  function request(operation, payload, timeoutMs) {
    if (terminated) return Promise.reject(new Error('Worker BLE SmallRig déjà arrêté'));
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++;
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return;
        const error = new Error(
          `Le worker BLE SmallRig ne répond plus pendant ${operation} (timeout ${timeoutMs} ms)`
        );
        error.code = 'SMALLRIG_BLE_WORKER_TIMEOUT';
        connected = false;
        reject(error);
        rejectPending(error);
        terminate();
      }, timeoutMs);
      pending.set(requestId, { operation, resolve, reject, timer });
      try {
        child.send({ type: 'request', requestId, operation, payload });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  let opened;
  try {
    opened = await request('open', {
      mode,
      selector: {
        bleDeviceId: selector?.bleDeviceId || selector?.id || null,
        deviceUuid: normalizeHexIdentity(selector?.deviceUuid),
        networkId: normalizeHexIdentity(selector?.networkId)
      },
      scanTimeoutMs
    }, openTimeoutMs);
    connected = true;
  } catch (error) {
    terminate();
    throw error;
  }

  let closed = false;
  return {
    maxAttributeValueLength: Number(opened?.maxAttributeValueLength) || DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH,
    selectedDevice: opened?.selectedDevice || null,
    async write(buffer) {
      if (closed || !connected) throw new Error('Connexion GATT fermée');
      const exact = Buffer.from(buffer);
      await request('write', { data: exact.toString('base64') }, writeTimeoutMs);
    },
    async close() {
      if (closed) return;
      closed = true;
      connected = false;
      try {
        if (!terminated) await request('close', {}, closeTimeoutMs);
      } catch (error) {
        // Même contrat que l'ancien transport : une fermeture best-effort ne masque
        // pas le résultat du provisioning/configuration qui vient de se terminer.
        log.warn('Fermeture du worker BLE SmallRig en erreur', error?.message || String(error));
      } finally {
        terminate();
      }
    },
    get connected() {
      return !closed && connected && !terminated;
    }
  };
}

export async function openProvisioningConnection(device, { onData } = {}) {
  if (!device?.gatt) {
    return openBrokeredGattConnection('provisioning', device, { onData });
  }
  return openGattConnection(device, {
    serviceUuid: GATT.PROVISIONING_SERVICE,
    dataInUuid: GATT.PROVISIONING_DATA_IN,
    dataOutUuid: GATT.PROVISIONING_DATA_OUT,
    onData
  });
}

export async function openProxyConnection(device, { onData } = {}) {
  if (!device?.gatt) {
    return openBrokeredGattConnection('proxy', device, { onData });
  }
  return openGattConnection(device, {
    serviceUuid: GATT.PROXY_SERVICE,
    dataInUuid: GATT.PROXY_DATA_IN,
    dataOutUuid: GATT.PROXY_DATA_OUT,
    onData
  });
}

// Après le Provisioning Complete, la lampe passe de l'annonce 0x1827 à 0x1828 et il
// faut se reconnecter (§4 "Après le Complete"). Rescanne spécifiquement le service
// Proxy en filtrant sur le Device UUID déjà connu si possible (sinon renvoie le
// premier device Proxy vu — le mesh-client validera via le NID au déchiffrement).
export async function waitForProxyAdvertisement({ timeoutMs = 5000, retryDelayMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // Fenêtres assez longues pour recevoir les Service Data complètes. Ce scan reste
  // isolé ; la future connexion rescannera la même identité dans son worker de
  // session. Aucun handle natif ne traverse donc l'IPC ni le processus Electron.
  const minSubScanMs = 6000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const found = await scanForLampAdvertisements({
        timeoutMs: Math.max(minSubScanMs, Math.min(8000, remaining))
      });
      const proxy = found.filter((lamp) => lamp.kind === 'provisioned');
      if (proxy.length > 0) return proxy;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (lastError) throw lastError;
  throw new Error('Aucune lampe en mode Proxy détectée après provisioning');
}
