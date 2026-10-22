// Client du protocole des appareils LAN du compagnon Klixa (klixa-companion/protocol/devices-messages.md)
// pour Node.js : connexion WebSocket SORTANTE vers le compagnon, annonce des éléments (`hello`),
// exécution des commandes (`command` → `ack`), reconnexion automatique avec délai croissant.
import WebSocket from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('device-agent');

// La v2 du protocole apporte les éléments de type `light`.
export const PROTOCOL_VERSION = 2;

/**
 * @param {object} options
 * @param {string} options.url ws://<ip-du-compagnon>:8786/devices/ws
 * @param {string} options.token token de l'appareil, généré dans l'app Klixa Companion
 * @param {string} options.deviceId doit correspondre à l'identifiant choisi à la génération du token
 * @param {string} [options.name]
 * @param {() => object[]} options.getElements éléments à annoncer (relus à chaque connexion)
 * @param {(elementId: string, action: string, payload: object, data: object) => Promise<object|void>} options.onCommand
 */
export function createDeviceAgent({
  url,
  token,
  deviceId,
  name,
  getElements,
  onCommand,
  reconnectMinMs = 1000,
  reconnectMaxMs = 30000,
  WebSocketImpl = WebSocket
}) {
  let socket = null;
  let stopping = false;
  let attempt = 0;
  let timer = null;

  function send(message) {
    if (socket && socket.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify(message));
  }

  async function handleCommand(message) {
    try {
      const result = await onCommand(message.elementId, message.action, message.payload || {}, message.data || {});
      send({ type: 'ack', id: message.id, ok: true, result: result || {} });
    } catch (error) {
      log.warn(`Erreur sur ${message.elementId}.${message.action}`, error?.message || String(error));
      send({ type: 'ack', id: message.id, ok: false, error: error?.message || String(error) });
    }
  }

  function scheduleReconnect() {
    if (stopping) return;
    attempt += 1;
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * (2 ** (attempt - 1)));
    log.info(`Reconnexion dans ${(delay / 1000).toFixed(1)}s (tentative ${attempt})`);
    timer = setTimeout(connect, delay);
    timer.unref?.();
  }

  function connect() {
    if (stopping) return;
    const ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    socket = ws;

    ws.on('open', () => {
      send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceId, name: name || deviceId, elements: getElements() });
    });

    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }

      if (message.type === 'registered') {
        if (message.ok) {
          attempt = 0; // une connexion enregistrée réinitialise le délai
          log.info('Connecté et enregistré auprès du compagnon.');
        } else {
          log.error(`Enregistrement refusé : ${message.error || 'raison inconnue'}`);
        }
        return;
      }
      if (message.type === 'command') handleCommand(message);
    });

    ws.on('close', (code) => {
      if (socket === ws) socket = null;
      log.warn(`Connexion fermée (code ${code})`);
      scheduleReconnect();
    });
    ws.on('error', (error) => log.warn('Erreur de connexion', error?.message || String(error)));
  }

  return {
    start: connect,
    stop() {
      stopping = true;
      clearTimeout(timer);
      try { socket?.close(1001, 'shutting-down'); } catch { /* déjà fermée */ }
    }
  };
}
