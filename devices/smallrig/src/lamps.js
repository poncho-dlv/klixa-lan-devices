import { createLogger } from './logger.js';
import { hexToHueSat } from './ble/color-convert.js';
import { createMeshClient } from './ble/mesh-client.js';
import { parseMeshState, serializeMeshState } from './ble/mesh-store.js';
import { isHexColor, clamp } from './light-utils.js';

const log = createLogger('smallrig');

// ble-transport.js n'importe l'addon natif que dans un worker dédié ; ce chargement paresseux
// confine une anomalie Bluetooth à la commande qui l'a déclenchée (ex. pilote installé après coup).
let bleTransportPromise;
function loadBleTransport() {
  if (!bleTransportPromise) {
    bleTransportPromise = import('./ble/ble-transport.js').catch((err) => {
      bleTransportPromise = null; // permet de retenter
      throw new Error(`Bluetooth indisponible sur cette machine : ${err.message}`);
    });
  }
  return bleTransportPromise;
}

const DEFAULT_INTENSITY = 85;
// Lecture de snapshot : timeout court, best-effort (repli sur « allumée »).
const SNAPSHOT_READ_OPTIONS = { timeoutMs: 1200, closeOnTimeout: false };
const STATUS_READ_OPTIONS = { timeoutMs: 12000 };

/** Effets matériels RM75 (modes Lq 1-12) — l'id d'effet annoncé à Klixa est le numéro de mode. */
export const FX_MODES = Object.freeze([
  { id: '1', label: 'Paparazzi (flash appareil photo)' },
  { id: '2', label: 'Cycle de couleurs' },
  { id: '3', label: 'Éclair' },
  { id: '4', label: 'Pulsation (respiration)' },
  { id: '5', label: 'SOS' },
  { id: '6', label: 'Soudure' },
  { id: '7', label: 'Alarme' },
  { id: '8', label: 'Feu d’artifice' },
  { id: '9', label: 'Aléatoire' },
  { id: '10', label: 'Feu' },
  { id: '11', label: 'Scintillement TV' },
  { id: '12', label: 'Ampoule défectueuse' }
]);

/** Plage de température de couleur annoncée à Klixa (blanc réglable de la RM75, valeurs usuelles — non confirmées sur matériel). */
export const KELVIN_RANGE = Object.freeze({ min: 2500, max: 10000 });

const toHex2 = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');

/** Teinte/saturation (0-360 / 0-100, valeur maximale) → `#RRGGBB`. Inverse de hexToHueSat. Pur. */
export function hueSatToHex(hue, sat) {
  const s = Math.max(0, Math.min(100, Number(sat) || 0)) / 100;
  const h = (((Number(hue) || 0) % 360) + 360) % 360 / 60;
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
  return `#${[r + m, g + m, b + m].map((channel) => toHex2(channel * 255)).join('').toUpperCase()}`;
}

/** Fusion d'un patch de baseline avec l'état précédent d'une lampe. Pur, testé. */
export function mergeBaseline(previous, patch) {
  const base = previous || { status: null, poweredOn: true };
  return {
    status: patch.status !== undefined ? patch.status : base.status,
    poweredOn: patch.poweredOn !== undefined ? patch.poweredOn : base.poweredOn
  };
}

/**
 * État mémorisé d'une lampe → charge utile `set` du protocole des appareils LAN (le même format que
 * celle que Klixa envoie), pour que le compagnon puisse restaurer l'état d'avant. Pur, testé.
 */
export function baselineToPayload(baseline) {
  if (!baseline || baseline.poweredOn === false) {
    return baseline ? { on: false } : { on: true };
  }
  const status = baseline.status;
  switch (status?.type) {
    case 'hsi':
      return { on: true, color: status.hex || hueSatToHex(status.hue, status.sat), brightness: status.intensity };
    case 'cct':
      return { on: true, kelvin: status.kelvin, brightness: status.intensity };
    case 'rgbw':
      return { on: true, color: `#${[status.r, status.g, status.b].map(toHex2).join('').toUpperCase()}` };
    case 'fx':
      return { on: true, fx: String(status.mode) };
    default:
      return { on: true };
  }
}

export function assertLightCommandResults(command, uuid, batches) {
  const results = batches.flatMap((batch) => (Array.isArray(batch) ? batch : [batch])).filter(Boolean);
  const failures = results.filter((result) => result.ok !== true);
  if (failures.length > 0 || results.length === 0) {
    const details = failures.map((failure) => failure.error || 'échec inconnu').join('; ') || 'aucun résultat';
    const error = new Error(`${command} incomplète (${uuid}: ${details})`);
    error.code = 'SMALLRIG_COMMAND_FAILED';
    throw error;
  }
  return results;
}

/**
 * Contrôleur des lampes SmallRig RM75 (Bluetooth Mesh) : une instance = un état mesh (clés, nœuds,
 * séquences) persisté par `config.onStateChange`. Pilote UNE lampe à la fois (le script d'appareil
 * LAN expose chaque lampe comme un élément `light`) ; le maintien temporaire et la restauration sont
 * faits par le compagnon, ce contrôleur ne fournit que `setState` et `getState`.
 * @param {{ meshStateJson?: string, onStateChange?: (json: string) => Promise<void>, maxLamps?: number, seqBlockSize?: number }} config
 */
export function createLampController(config = {}) {
  const maxLamps = Math.max(1, Math.min(200, Math.trunc(config.maxLamps) || 50));

  let state = parseMeshState(config.meshStateJson);
  let persistenceFailure = null;

  async function persistState(nextState) {
    if (config.onStateChange) {
      try {
        await config.onStateChange(serializeMeshState(nextState));
      } catch (err) {
        const failure = new Error(`Échec de la persistance de l’état Mesh SmallRig : ${err.message}`, { cause: err });
        failure.code = 'SMALLRIG_STATE_PERSIST_FAILED';
        persistenceFailure = failure;
        log.error(failure.message);
        throw failure;
      }
    }
    state = nextState;
    persistenceFailure = null;
  }

  const client = createMeshClient({
    getState: () => {
      if (persistenceFailure) throw persistenceFailure;
      return state;
    },
    persistState,
    scanForLampAdvertisements: async (...args) => (await loadBleTransport()).scanForLampAdvertisements(...args),
    scanForDisplay: async (...args) => (await loadBleTransport()).scanForLampAdvertisements(...args),
    openProvisioningConnection: async (...args) => (await loadBleTransport()).openProvisioningConnection(...args),
    openProxyConnection: async (...args) => (await loadBleTransport()).openProxyConnection(...args),
    waitForProxyAdvertisement: async (...args) => (await loadBleTransport()).waitForProxyAdvertisement(...args),
    seqBlockSize: Math.max(10, Math.trunc(config.seqBlockSize) || 100)
  });

  // Dernier état ÉCRIT par ce script, par lampe : sert de snapshot de restauration sans aller-retour BLE
  // (la lecture mesh ne subsiste qu'en repli, au plus une fois par lampe et par session). Compromis
  // assumé : un état changé hors de ce script (app SmallGoGo, boutons) n'est pas vu.
  const baselineByUuid = new Map();

  function assertKnown(uuid) {
    if (!client.listNodes().some((node) => node.uuid === uuid)) {
      throw new Error('Lampe inconnue (uuid non trouvé parmi les lampes provisionnées)');
    }
  }

  async function execute(command, uuid, operation, baselinePatch) {
    assertLightCommandResults(command, uuid, [await operation()]);
    if (baselinePatch) baselineByUuid.set(uuid, mergeBaseline(baselineByUuid.get(uuid), baselinePatch));
  }

  /** Applique un état (`{ on, color, brightness, kelvin, fx }`, format de l'élément `light`). */
  async function setState(uuid, wanted = {}) {
    assertKnown(uuid);

    if (wanted.on === false) {
      await execute('Extinction', uuid, () => client.setPower([uuid], { on: false }), { poweredOn: false });
      return { applied: true };
    }

    const intensity = clamp(wanted.brightness, 1, 100, DEFAULT_INTENSITY);

    if (wanted.fx !== undefined && wanted.fx !== null && wanted.fx !== '') {
      const mode = Math.trunc(Number(wanted.fx));
      if (!(mode >= 1 && mode <= 12)) throw new Error(`Effet inconnu : ${wanted.fx}`);
      await execute('Effet dynamique', uuid, () => client.setFx([uuid], { mode, param1: 0, param2: 0 }),
        { status: { type: 'fx', mode, freq: 0, intensity: 0 }, poweredOn: true });
    } else if (isHexColor(wanted.color)) {
      const hex = wanted.color.toUpperCase();
      const { hue, sat } = hexToHueSat(hex);
      await execute('Commande couleur', uuid, () => client.setHsi([uuid], { hue, sat, intensity }),
        { status: { type: 'hsi', hue, sat, intensity, hex }, poweredOn: true });
    } else if (Number.isFinite(Number(wanted.kelvin))) {
      const kelvin = Math.round(clamp(wanted.kelvin, KELVIN_RANGE.min, KELVIN_RANGE.max, 5600));
      await execute('Commande température', uuid, () => client.setCct([uuid], { kelvin, intensity, gm: 0 }),
        { status: { type: 'cct', kelvin, intensity, gm: 0 }, poweredOn: true });
    } else {
      const level = wanted.brightness === undefined ? undefined : clamp(wanted.brightness, 0, 100, undefined);
      await execute('Allumage', uuid, () => client.setPower([uuid], { on: true, level }), { poweredOn: true });
    }

    return { applied: true };
  }

  /** État courant au format `set` (baseline logicielle, sinon lecture mesh best-effort, sinon « allumée »). */
  async function getState(uuid) {
    assertKnown(uuid);

    let baseline = baselineByUuid.get(uuid);
    if (!baseline) {
      const [status, capacity] = await Promise.all([
        client.readStatus(uuid, SNAPSHOT_READ_OPTIONS).catch(() => null),
        client.readCapacity(uuid, SNAPSHOT_READ_OPTIONS).catch(() => null)
      ]);
      baseline = { status, poweredOn: capacity?.poweredOn };
      baselineByUuid.set(uuid, baseline);
    }
    return baselineToPayload(baseline);
  }

  async function status(uuid) {
    assertKnown(uuid);
    let lightState;
    let capacity;
    try { lightState = await client.readStatus(uuid, STATUS_READ_OPTIONS); } catch (err) { lightState = { error: err.message }; }
    try { capacity = await client.readCapacity(uuid, STATUS_READ_OPTIONS); } catch (err) { capacity = { error: err.message }; }
    return { state: lightState, capacity };
  }

  async function provision({ bleDeviceId, deviceUuid, name } = {}) {
    if (!bleDeviceId) throw new Error('bleDeviceId manquant (relancez la découverte)');
    const normalizedUuid = String(deviceUuid || '').trim().toLowerCase() || null;
    if (normalizedUuid && !/^[0-9a-f]{32}$/.test(normalizedUuid)) throw new Error('deviceUuid SmallRig invalide');
    const replaces = Boolean(normalizedUuid && state.nodes.some((node) => node.uuid === normalizedUuid));
    if (state.nodes.length >= maxLamps && !replaces) throw new Error(`Nombre maximum de lampes atteint (${maxLamps})`);

    const result = await client.provision({ bleDeviceId, deviceUuid: normalizedUuid, name: name ? String(name).trim().slice(0, 128) : null });
    if (result.configured === false) log.warn('Lampe provisionnée mais configuration en attente', result);
    return result;
  }

  async function reconfigure(uuid) {
    const node = state.nodes.find((candidate) => candidate.uuid === uuid);
    if (!node) throw new Error('Lampe inconnue (uuid non trouvé parmi les lampes provisionnées)');
    await client.configureNode(node);
    return { uuid, name: node.name, unicastAddress: node.unicastAddress };
  }

  async function forget(uuid, { forceLocal = false } = {}) {
    const result = await client.forget({ uuid, forceLocal });
    if (result.removed) baselineByUuid.delete(uuid);
    return result;
  }

  return {
    list: () => client.listNodes(),
    discover: ({ timeoutMs = 6000 } = {}) => client.discover({ timeoutMs: clamp(timeoutMs, 1000, 20000, 6000) }),
    provision,
    reconfigure,
    forget,
    status,
    setState,
    getState,
    stop: () => client.stop()
  };
}
