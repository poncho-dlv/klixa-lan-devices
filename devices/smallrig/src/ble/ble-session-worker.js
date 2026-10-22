// Broker GATT SmallRig exécuté dans un processus Node dédié.
//
// SimpleBLE Windows expose actuellement des opérations WinRT synchrones. Les appeler
// depuis le processus principal Electron bloque son thread UI et réutilise son
// appartement COM STA. Ce worker possède tout le cycle natif (scan -> connexion ->
// notifications/écritures -> fermeture) ; le parent n'échange que des messages IPC
// sérialisables et peut tuer ce processus si WinRT ne répond plus.

import {
  openProvisioningConnection,
  openProxyConnection,
  scanForLampAdvertisementsInProcess
} from './ble-transport.js';

let connection = null;
let operationChain = Promise.resolve();

function normalizeHex(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return Buffer.from(value).toString('hex');
  return String(value).trim().toLowerCase() || null;
}

function summarize(lamp) {
  return {
    bleDeviceId: lamp.bleDeviceId,
    kind: lamp.kind,
    deviceUuid: normalizeHex(lamp.deviceUuid),
    networkId: normalizeHex(lamp.networkId),
    rssi: lamp.rssi,
    name: lamp.name
  };
}

function selectProvisioningTarget(lamps, selector) {
  const candidates = lamps.filter((lamp) => lamp.kind === 'unprovisioned');
  const expectedUuid = normalizeHex(selector?.deviceUuid);
  if (expectedUuid) {
    const stable = candidates.find((lamp) => normalizeHex(lamp.deviceUuid) === expectedUuid);
    if (stable) return stable;
  }
  if (selector?.bleDeviceId) {
    const byAddress = candidates.find((lamp) => lamp.bleDeviceId === selector.bleDeviceId);
    if (byAddress) return byAddress;
  }
  // Sans identité exploitable, ne jamais provisionner arbitrairement une lampe si
  // plusieurs RM75 sont visibles. Une cible unique reste sûre pour le diagnostic et
  // les anciennes versions de l'UI qui ne transmettaient pas encore le Device UUID.
  return candidates.length === 1 ? candidates[0] : null;
}

function selectProxyTargets(lamps, selector) {
  const candidates = lamps.filter((lamp) => lamp.kind === 'provisioned');
  const expectedNetworkId = normalizeHex(selector?.networkId);
  const exactNetwork = expectedNetworkId
    ? candidates.filter((lamp) => normalizeHex(lamp.networkId) === expectedNetworkId)
    : [];
  const expectedAddress = selector?.bleDeviceId
    ? candidates.filter((lamp) => lamp.bleDeviceId === selector.bleDeviceId)
    : [];
  const nodeIdentity = candidates.filter((lamp) => !lamp.networkId);

  // Un Proxy du même Network ID est équivalent à un autre pour relayer les messages
  // Mesh. L'adresse BLE est une RPA et peut changer entre les deux scans.
  return [...new Set([...exactNetwork, ...expectedAddress, ...nodeIdentity])];
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    phase: error?.phase,
    nativeDiagnostics: error?.nativeDiagnostics,
    stack: error?.stack
  };
}

function send(message) {
  if (process.connected) process.send?.(message);
}

async function closeConnection() {
  const current = connection;
  connection = null;
  if (current) await current.close();
}

async function openSession({ mode, selector, scanTimeoutMs }) {
  await closeConnection();
  // Sortie anticipée (mode Proxy uniquement) : dès qu'une lampe provisionnée du
  // Network ID ciblé est vue, inutile d'attendre la fin de la fenêtre — n'importe
  // quel Proxy du même réseau relaie les messages mesh (cf. selectProxyTargets).
  // Jamais sur une annonce Node Identity (réseau non vérifiable avant connexion) ni
  // en mode provisioning (opération manuelle rare, on garde la fenêtre complète pour
  // fiabiliser la découverte).
  const expectedNetworkId = normalizeHex(selector?.networkId);
  const stopWhen = mode === 'proxy' && expectedNetworkId
    ? (lamp) => lamp.kind === 'provisioned' && normalizeHex(lamp.networkId) === expectedNetworkId
    : undefined;
  const lamps = await scanForLampAdvertisementsInProcess({ timeoutMs: scanTimeoutMs, stopWhen });
  // SmallGoGo laisse elle aussi retomber le watcher avant connectGatt. Ce repos est
  // exécuté dans le worker (jamais sur le thread UI Electron) et évite que WinRT voie
  // encore le scan actif au moment d'ouvrir la session GATT.
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (mode === 'provisioning') {
    const target = selectProvisioningTarget(lamps, selector);
    if (!target) {
      const visible = lamps.map(summarize);
      const error = new Error(
        `Lampe non provisionnée ciblée introuvable dans le worker BLE (visibles: ${JSON.stringify(visible)})`
      );
      error.code = 'SMALLRIG_TARGET_NOT_FOUND';
      throw error;
    }
    connection = await openProvisioningConnection(target.device, {
      onData: (bytes) => send({ type: 'notification', data: Buffer.from(bytes).toString('base64') })
    });
    return {
      maxAttributeValueLength: connection.maxAttributeValueLength,
      selectedDevice: summarize(target)
    };
  }

  if (mode === 'proxy') {
    const candidates = selectProxyTargets(lamps, selector);
    if (candidates.length === 0) {
      const error = new Error('Aucun Proxy du réseau SmallRig ciblé détecté dans le worker BLE');
      error.code = 'SMALLRIG_PROXY_NOT_FOUND';
      throw error;
    }
    let lastError;
    for (const candidate of candidates) {
      try {
        connection = await openProxyConnection(candidate.device, {
          onData: (bytes) => send({ type: 'notification', data: Buffer.from(bytes).toString('base64') })
        });
        return {
          maxAttributeValueLength: connection.maxAttributeValueLength,
          selectedDevice: summarize(candidate)
        };
      } catch (error) {
        lastError = error;
        await closeConnection();
      }
    }
    throw lastError || new Error('Connexion Proxy impossible dans le worker BLE');
  }

  throw new Error(`Mode de session BLE inconnu : ${mode}`);
}

async function handleRequest(message) {
  const { requestId, operation, payload = {} } = message;
  try {
    let result;
    if (operation === 'open') {
      result = await openSession(payload);
    } else if (operation === 'write') {
      if (!connection?.connected) throw new Error('Connexion GATT worker fermée');
      await connection.write(Buffer.from(payload.data || '', 'base64'));
      result = {};
    } else if (operation === 'close') {
      await closeConnection();
      result = {};
    } else {
      throw new Error(`Opération worker BLE inconnue : ${operation}`);
    }
    send({ type: 'response', requestId, ok: true, result });
    if (operation === 'close') {
      process.disconnect?.();
    }
  } catch (error) {
    send({ type: 'response', requestId, ok: false, error: serializeError(error) });
  }
}

process.on('message', (message) => {
  if (!message || message.type !== 'request') return;
  operationChain = operationChain.then(
    () => handleRequest(message),
    () => handleRequest(message)
  );
});

process.on('disconnect', () => {
  // Si le parent disparaît, ne pas conserver une connexion radio orpheline. Le
  // timeout externe du parent reste le dernier recours si close() bloque lui aussi.
  void closeConnection().finally(() => { process.exitCode = 0; });
});
