// Les appareils embarquent une COPIE du SDK Python (déploiement autonome sur un Raspberry Pi) : elle ne doit
// jamais dériver de la version de référence de sdk/python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('devices/smoke-machine/klixa_device_agent.py est identique au SDK de référence', () => {
    assert.equal(read('devices/smoke-machine/klixa_device_agent.py'), read('sdk/python/klixa_device_agent.py'));
});

test('devices/smallrig-python/klixa_device_agent.py est identique au SDK de référence', () => {
    assert.equal(read('devices/smallrig-python/klixa_device_agent.py'), read('sdk/python/klixa_device_agent.py'));
});
