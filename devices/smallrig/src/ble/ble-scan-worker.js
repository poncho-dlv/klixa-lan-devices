// Processus enfant dédié au scan BLE de découverte (bouton "Scanner" de l'UI).
//
// Pourquoi un processus séparé : sur certaines machines Windows, l'appel natif de
// scan (SimpleBLE -> WinRT BluetoothLEAdvertisementWatcher) peut rester bloqué
// indéfiniment côté natif (observé en production : CPU bas, mais aucune réponse —
// le blocage est une attente synchrone, pas une boucle qui consommerait du CPU).
// Un timeout JS classique (setTimeout/Promise.race) ne sert à rien dans ce cas :
// si l'appel natif bloque le thread principal, la boucle d'événements Node ne tourne
// plus et le timer ne se déclenche jamais — tout le compagnon (Hue/OBS/Streamer.bot
// inclus) resterait figé. En isolant le scan dans ce processus, le process principal
// reste réactif et peut FORCER l'arrêt (SIGKILL) si ce processus ne répond pas à temps
// (cf. ble-transport.js#scanForLampAdvertisements côté process principal).
//
// Ne gère QUE le scan d'affichage (discover()) : provision()/reconnexion Proxy ont
// besoin d'un handle `device` réel (natif, non sérialisable entre processus) pour se
// connecter ensuite, et restent donc en process principal — même risque de blocage
// non résolu pour ces étapes, à isoler séparément si le besoin se confirme.

import { scanForLampAdvertisementsInProcess } from './ble-transport.js';

// Filet de sécurité contre un bug observé dans webbluetooth : `adapter.startScan(...)`
// peut rejeter sans que ce rejet soit attendu/catché dans son propre code (appel non
// awaité dans `Bluetooth.requestDevice`), ce qui ferait planter ce processus par
// défaut (Node >= 15 termine le process sur un rejet non géré). On convertit ça en
// résultat d'erreur normal — bien plus informatif côté process principal qu'un simple
// "code de sortie inattendu".
function scanWithRejectionGuard(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onUnhandledRejection = (err) => {
      if (settled) return;
      settled = true;
      process.removeListener('unhandledRejection', onUnhandledRejection);
      reject(err);
    };
    process.once('unhandledRejection', onUnhandledRejection);

    scanForLampAdvertisementsInProcess({ timeoutMs }).then(
      (result) => {
        if (settled) return;
        settled = true;
        process.removeListener('unhandledRejection', onUnhandledRejection);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        process.removeListener('unhandledRejection', onUnhandledRejection);
        reject(err);
      }
    );
  });
}

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'scan') return;
  try {
    const found = await scanWithRejectionGuard(msg.timeoutMs);
    const lamps = found.map(({ device: _device, deviceUuid, networkId, ...rest }) => ({
      ...rest,
      deviceUuid: deviceUuid ? deviceUuid.toString('hex') : undefined,
      networkId: networkId ? networkId.toString('hex') : undefined
    }));
    process.send?.({ type: 'result', ok: true, lamps });
  } catch (err) {
    process.send?.({ type: 'result', ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    process.exitCode = 0;
    process.disconnect?.();
  }
});
