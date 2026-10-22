import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToHueSat } from '../src/ble/color-convert.js';

test('hexToHueSat: rouge pur -> hue 0, sat 100', () => {
  assert.deepEqual(hexToHueSat('#FF0000'), { hue: 0, sat: 100 });
});

test('hexToHueSat: vert pur -> hue 120, sat 100', () => {
  assert.deepEqual(hexToHueSat('#00FF00'), { hue: 120, sat: 100 });
});

test('hexToHueSat: bleu pur -> hue 240, sat 100', () => {
  assert.deepEqual(hexToHueSat('#0000FF'), { hue: 240, sat: 100 });
});

test('hexToHueSat: blanc -> sat 0 (hue non pertinent)', () => {
  assert.equal(hexToHueSat('#FFFFFF').sat, 0);
});

test('hexToHueSat: noir -> sat 0, pas de division par zéro', () => {
  assert.deepEqual(hexToHueSat('#000000'), { hue: 0, sat: 0 });
});
