import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHeadlessSmallrigState } from '../src/state-file.js';

test('mode headless recharge puis remplace atomiquement l’état Mesh', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-smallrig-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mesh.json');
  fs.writeFileSync(file, '{"seq":100}\n', 'utf8');
  const config = { enabled: true, meshStateFile: file, meshStateJson: '' };

  configureHeadlessSmallrigState(config);
  assert.equal(config.meshStateJson, '{"seq":100}');
  await config.onStateChange('{"seq":200}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"seq":200}\n');
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('mode headless échoue fermé sans fichier de persistance', async () => {
  const config = { enabled: true, meshStateFile: '' };
  configureHeadlessSmallrigState(config);

  await assert.rejects(
    config.onStateChange('{}'),
    (error) => error.code === 'SMALLRIG_STATE_FILE_REQUIRED'
  );
});

test('mode headless refuse un fichier d’état vide', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-smallrig-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mesh.json');
  fs.writeFileSync(file, '  \n', 'utf8');

  assert.throws(
    () => configureHeadlessSmallrigState({ enabled: true, meshStateFile: file, meshStateJson: '' }),
    /fichier existe mais il est vide/
  );
});

test('mode headless resserre les permissions du fichier de clés', {
  skip: process.platform === 'win32'
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-smallrig-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mesh.json');
  fs.writeFileSync(file, '{}\n', { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(file, 0o644);

  configureHeadlessSmallrigState({ enabled: true, meshStateFile: file, meshStateJson: '' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('mode headless ne configure rien lorsque SmallRig est désactivé', () => {
  const config = { enabled: false };
  configureHeadlessSmallrigState(config);
  assert.equal(config.onStateChange, undefined);
});
