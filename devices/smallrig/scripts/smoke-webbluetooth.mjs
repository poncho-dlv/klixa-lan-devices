import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aesCcmDecrypt, aesCcmEncrypt } from '../src/ble/mesh-crypto.js';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const packageRoot = resolve(projectRoot, 'node_modules', 'webbluetooth');

const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.version, '3.7.0', 'La version de webbluetooth doit rester alignée avec le patch 3.7.0');

const adapterSource = await readFile(resolve(packageRoot, 'dist', 'adapters', 'simpleble-adapter.js'), 'utf8');
const bluetoothSource = await readFile(resolve(packageRoot, 'dist', 'bluetooth.js'), 'utf8');
const serverSource = await readFile(resolve(packageRoot, 'dist', 'server.js'), 'utf8');
const patchAssertions = [
  [adapterSource.includes('setCallbackOnScanUpdated(handlePeripheral)'), 'callback scanUpdated absent'],
  [adapterSource.includes('setCallbackOnScanStop'), 'attente du callback scanStop absente'],
  [adapterSource.includes('scan stop confirmation timed out'), 'timeout de confirmation scanStop absent'],
  [adapterSource.includes('this.handles = new PeripheralHandles(this.peripherals)'), 'purge du graphe GATT absente'],
  [!adapterSource.includes('if (!peripheral.connectable)'), 'pré-vérification connectable encore présente'],
  [bluetoothSource.includes('this.cancelPromise'), 'propagation asynchrone de cancelRequest absente'],
  [serverSource.includes('return pending'), 'Promise de déconnexion GATT absente']
];
for (const [condition, detail] of patchAssertions) {
  assert.ok(condition, `Le patch webbluetooth n'est pas appliqué complètement (${detail})`);
}

const imported = await import('webbluetooth');
const api = imported.default ?? imported;
assert.equal(typeof (imported.Bluetooth ?? api.Bluetooth), 'function', 'Export Bluetooth introuvable');
assert.equal(typeof (imported.getAdapters ?? api.getAdapters), 'function', 'Export getAdapters introuvable');
if (process.platform === 'win32' && process.arch === 'x64') {
  const nativeImported = await import('webbluetooth/dist/adapters/simpleble.js');
  const native = nativeImported.default ?? nativeImported;
  assert.equal(
    native.klixaPatchVersion,
    'rm75-gatt-discovery-v3',
    'Le binding Windows chargé ne contient pas le correctif natif de découverte GATT'
  );
}

// Electron utilise BoringSSL et n'expose pas AES-CCM via node:crypto. Ce KAT doit
// donc tourner dans les deux runtimes afin d'empêcher qu'un build valide le BLE mais
// échoue seulement au dernier échange cryptographique du provisioning réel.
const ccmKey = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const ccmNonce = Buffer.from('00112233445566778899aabbcc', 'hex');
const ccmPlaintext = Buffer.from('2433040000006464', 'hex');
for (const [micLength, expectedMic] of [[4, '1c0c6073'], [8, '0a8a4266bf76afbd']]) {
  const encrypted = aesCcmEncrypt(ccmKey, ccmNonce, ccmPlaintext, micLength);
  assert.equal(encrypted.ciphertext.toString('hex'), '08f799300f3fae2d', `AES-CCM-${micLength} ciphertext invalide`);
  assert.equal(encrypted.mic.toString('hex'), expectedMic, `AES-CCM-${micLength} MIC invalide`);
  assert.deepEqual(
    aesCcmDecrypt(ccmKey, ccmNonce, encrypted.ciphertext, encrypted.mic, micLength),
    ccmPlaintext,
    `AES-CCM-${micLength} ne se déchiffre pas`
  );
}

const runtime = process.versions.electron
  ? `Electron ${process.versions.electron} / Node ${process.versions.node}`
  : `Node ${process.versions.node}`;
console.log(`webbluetooth 3.7.0 et AES-CCM chargés et vérifiés sous ${runtime} (${process.platform}-${process.arch})`);

const nodeOnly = process.argv.includes('--node-only');
const electronChild = process.argv.includes('--electron-child') || Boolean(process.versions.electron);
if (!nodeOnly && !electronChild) {
  const require = createRequire(import.meta.url);
  const electronPath = require('electron');
  const child = spawnSync(electronPath, [scriptPath, '--electron-child'], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 30000,
    windowsHide: true
  });

  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Le smoke test Electron a échoué${child.signal ? ` (${child.signal})` : ''}`);
}
