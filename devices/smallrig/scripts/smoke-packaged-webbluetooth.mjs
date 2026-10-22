import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32', 'Ce smoke test cible le paquet Electron Windows');

const unpackedDir = resolve(process.argv[2] ?? 'release/win-unpacked');
const executables = (await readdir(unpackedDir)).filter((name) => name.toLowerCase().endsWith('.exe'));
assert.ok(executables.length > 0, `Aucun exécutable Electron trouvé dans ${unpackedDir}`);

const executable = resolve(unpackedDir, executables[0]);
const packagedModule = resolve(
  unpackedDir,
  'resources',
  'app.asar',
  'node_modules',
  'webbluetooth',
  'dist',
  'adapters',
  'simpleble.js'
);
const packagedMeshCrypto = resolve(
  unpackedDir,
  'resources',
  'app.asar',
  'src',
  'integrations',
  'smallrig',
  'mesh-crypto.js'
);
const leakedBuildDirectory = resolve(
  unpackedDir,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'webbluetooth',
  'build'
);
const unpackedPrebuildDirectory = resolve(
  unpackedDir,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'webbluetooth',
  'prebuilds'
);

await assert.rejects(
  access(leakedBuildDirectory),
  (error) => error?.code === 'ENOENT',
  'Le répertoire de compilation webbluetooth ne doit pas être livré dans le paquet'
);
assert.deepEqual(
  await readdir(unpackedPrebuildDirectory, { recursive: true }),
  ['klixa-simpleble-win32-x64', join('klixa-simpleble-win32-x64', 'node-napi-v6.node')],
  'Seul le binding Windows corrigé doit être sorti de l’archive'
);

const childCode = [
  "const assert = require('node:assert/strict');",
  "const { pathToFileURL } = require('node:url');",
  "const addon = require(process.env.KLIXA_WEBBLUETOOTH_MODULE);",
  "if (!addon || typeof addon !== 'object') throw new Error('Binding SimpleBLE invalide');",
  "if (addon.klixaPatchVersion !== 'rm75-gatt-discovery-v3') throw new Error('Correctif GATT Klixa absent du binding');",
  '(async () => {',
  '  const { aesCcmDecrypt, aesCcmEncrypt } = await import(pathToFileURL(process.env.KLIXA_MESH_CRYPTO_MODULE).href);',
  "  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');",
  "  const nonce = Buffer.from('00112233445566778899aabbcc', 'hex');",
  "  const plaintext = Buffer.from('2433040000006464', 'hex');",
  '  const { ciphertext, mic } = aesCcmEncrypt(key, nonce, plaintext, 8);',
  "  assert.equal(ciphertext.toString('hex'), '08f799300f3fae2d');",
  "  assert.equal(mic.toString('hex'), '0a8a4266bf76afbd');",
  '  assert.deepEqual(aesCcmDecrypt(key, nonce, ciphertext, mic, 8), plaintext);',
  "  console.log('Binding webbluetooth et AES-CCM empaquetés vérifiés sous Electron ' + process.versions.electron);",
  '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });'
].join(' ');

const child = spawnSync(executable, ['-e', childCode], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    KLIXA_WEBBLUETOOTH_MODULE: packagedModule,
    KLIXA_MESH_CRYPTO_MODULE: packagedMeshCrypto
  },
  stdio: 'inherit',
  timeout: 30000,
  windowsHide: true
});

if (child.error) throw child.error;
assert.equal(child.status, 0, `Le binding empaqueté n'a pas pu être chargé${child.signal ? ` (${child.signal})` : ''}`);

// Validation matérielle facultative du chemin réellement livré : le processus
// Electron principal n'importe que le transport JS dans l'asar, puis celui-ci lance
// ses propres workers Node pour le scan et la session GATT. Aucun PDU de provisioning
// n'est envoyé ; le service 0x1827 est seulement ouvert, notifié, puis fermé.
if (process.argv.includes('--hardware')) {
  const packagedTransport = resolve(
    unpackedDir,
    'resources',
    'app.asar',
    'src',
    'integrations',
    'smallrig',
    'ble-transport.js'
  );
  const hardwareCode = [
    "const { pathToFileURL } = require('node:url');",
    '(async () => {',
    '  const transport = await import(pathToFileURL(process.env.KLIXA_BLE_TRANSPORT).href);',
    '  const lamps = await transport.scanForLampAdvertisements({ timeoutMs: 10000 });',
    "  const target = lamps.find((lamp) => lamp.kind === 'unprovisioned');",
    "  if (!target) throw new Error('Aucune RM75 non provisionnée détectée');",
    "  console.log('RM75 empaquetée détectée : ' + target.bleDeviceId + ' (' + target.rssi + ' dBm)');",
    '  const startedAt = Date.now();',
    '  const connection = await transport.openProvisioningConnection(target.device);',
    "  console.log('GATT 0x1827 empaqueté prêt en ' + (Date.now() - startedAt) + ' ms');",
    '  await connection.close();',
    "  console.log('Session GATT empaquetée fermée proprement');",
    '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });'
  ].join('\n');
  const hardware = spawnSync(executable, ['-e', hardwareCode], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KLIXA_BLE_TRANSPORT: packagedTransport
    },
    stdio: 'inherit',
    timeout: 90000,
    windowsHide: true
  });
  if (hardware.error) throw hardware.error;
  assert.equal(hardware.status, 0, `Le test GATT matériel empaqueté a échoué${hardware.signal ? ` (${hardware.signal})` : ''}`);
}
