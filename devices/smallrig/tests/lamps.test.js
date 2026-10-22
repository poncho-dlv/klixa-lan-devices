import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLightCommandResults,
  baselineToPayload,
  FX_MODES,
  hueSatToHex,
  mergeBaseline
} from '../src/lamps.js';
import { hexToHueSat } from '../src/ble/color-convert.js';
import { buildLightElements, createCommandHandler } from '../src/elements.js';
import { loadConfig } from '../src/config.js';

test('hueSatToHex est l’inverse de hexToHueSat pour les couleurs vives', () => {
  for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#FFFFFF']) {
    const { hue, sat } = hexToHueSat(hex);
    assert.equal(hueSatToHex(hue, sat), hex);
  }
});

test('mergeBaseline : status et alimentation évoluent indépendamment', () => {
  const first = mergeBaseline(undefined, { status: { type: 'hsi' }, poweredOn: true });
  assert.deepEqual(mergeBaseline(first, { poweredOn: false }), { status: { type: 'hsi' }, poweredOn: false });
  assert.deepEqual(mergeBaseline(first, { status: { type: 'cct' } }), { status: { type: 'cct' }, poweredOn: true });
});

test('baselineToPayload : état mémorisé → charge utile `set` rejouable par le compagnon', () => {
  assert.deepEqual(baselineToPayload(undefined), { on: true });
  assert.deepEqual(baselineToPayload({ status: null, poweredOn: false }), { on: false });
  assert.deepEqual(
    baselineToPayload({ status: { type: 'hsi', hue: 120, sat: 100, intensity: 70, hex: '#00FF00' }, poweredOn: true }),
    { on: true, color: '#00FF00', brightness: 70 }
  );
  assert.deepEqual(
    baselineToPayload({ status: { type: 'hsi', hue: 0, sat: 100, intensity: 50 }, poweredOn: true }),
    { on: true, color: '#FF0000', brightness: 50 }
  );
  assert.deepEqual(baselineToPayload({ status: { type: 'cct', kelvin: 4000, intensity: 60 }, poweredOn: true }), { on: true, kelvin: 4000, brightness: 60 });
  assert.deepEqual(baselineToPayload({ status: { type: 'rgbw', r: 255, g: 0, b: 0, w: 0 }, poweredOn: true }), { on: true, color: '#FF0000' });
  assert.deepEqual(baselineToPayload({ status: { type: 'fx', mode: 4 }, poweredOn: true }), { on: true, fx: '4' });
  assert.deepEqual(baselineToPayload({ status: { type: 'pickup' }, poweredOn: true }), { on: true });
});

test('assertLightCommandResults : échec ou absence de résultat lève une erreur codée', () => {
  assert.equal(assertLightCommandResults('Commande', 'u1', [{ ok: true, uuid: 'u1' }]).length, 1);
  assert.throws(() => assertLightCommandResults('Commande', 'u1', [[{ ok: false, uuid: 'u1', error: 'timeout' }]]), /timeout/);
  assert.throws(() => assertLightCommandResults('Commande', 'u1', [[]]), (error) => error.code === 'SMALLRIG_COMMAND_FAILED');
});

test('buildLightElements : une lampe = un élément light identifié par son uuid mesh', () => {
  const [element] = buildLightElements([{ uuid: 'abc123', name: 'Bureau' }]);
  assert.equal(element.id, 'abc123');
  assert.equal(element.type, 'light');
  assert.deepEqual(element.actions, ['set', 'getState']);
  assert.deepEqual(element.capabilities, ['onoff', 'dimming', 'color', 'color_temperature']);
  assert.equal(element.fxModes.length, FX_MODES.length);
  assert.ok(element.kelvin.min < element.kelvin.max);
  assert.equal(buildLightElements([{ uuid: 'x' }])[0].name, 'x');
});

test('createCommandHandler : set et getState sont aiguillés, le reste est refusé', async () => {
  const calls = [];
  const handler = createCommandHandler({
    setState: async (uuid, payload) => { calls.push(['set', uuid, payload]); return { applied: true }; },
    getState: async (uuid) => { calls.push(['get', uuid]); return { on: true }; }
  });
  assert.deepEqual(await handler('u1', 'set', { on: false }), { applied: true });
  assert.deepEqual(await handler('u1', 'getState'), { on: true });
  await assert.rejects(handler('u1', 'dance', {}), /Action inconnue/);
  assert.deepEqual(calls, [['set', 'u1', { on: false }], ['get', 'u1']]);
});

test('loadConfig : défauts et surcharges par l’environnement', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.companionUrl, 'ws://127.0.0.1:8786/devices/ws');
  assert.equal(defaults.deviceId, 'smallrig');
  assert.equal(defaults.deviceToken, '');
  assert.equal(defaults.maxLamps, 50);

  const custom = loadConfig({ COMPANION_URL: 'ws://192.168.1.30:8786/devices/ws', DEVICE_TOKEN: ' kxd_x ', SMALLRIG_MAX_LAMPS: '5' });
  assert.equal(custom.companionUrl, 'ws://192.168.1.30:8786/devices/ws');
  assert.equal(custom.deviceToken, 'kxd_x');
  assert.equal(custom.maxLamps, 5);
});
