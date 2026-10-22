// Éléments annoncés au compagnon : une lampe SmallRig = un élément `light` dont l'identifiant est
// l'uuid mesh de la lampe (le même que celui que Klixa utilisait pour SmallRig).
import { FX_MODES, KELVIN_RANGE } from './lamps.js';

export const LAMP_CAPABILITIES = Object.freeze(['onoff', 'dimming', 'color', 'color_temperature']);

/** @param {Array<{ uuid: string, name?: string }>} nodes lampes appairées */
export function buildLightElements(nodes) {
  return nodes.map((node) => ({
    id: node.uuid,
    type: 'light',
    name: node.name || node.uuid,
    actions: ['set', 'getState'],
    capabilities: [...LAMP_CAPABILITIES],
    kelvin: { ...KELVIN_RANGE },
    fxModes: FX_MODES.map((mode) => ({ ...mode }))
  }));
}

/**
 * Aiguille une commande du compagnon vers le contrôleur de lampes.
 * @param {{ setState: Function, getState: Function }} lamps
 */
export function createCommandHandler(lamps) {
  return async function onCommand(elementId, action, payload) {
    if (action === 'set') return lamps.setState(elementId, payload);
    if (action === 'getState') return lamps.getState(elementId);
    throw new Error(`Action inconnue : ${action}`);
  };
}
