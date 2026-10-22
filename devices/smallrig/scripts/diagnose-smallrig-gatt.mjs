import { openProvisioningConnection, scanForLampAdvertisements } from '../src/ble/ble-transport.js';

const requestedId = String(process.argv[2] || '').trim();
const timeoutMs = 10000;

console.log(`Scan BLE SmallRig pendant ${timeoutMs / 1000} s…`);
// Utilise exactement l'architecture desktop : scan isolé, puis worker de session
// persistant. Le processus appelant ne charge jamais directement SimpleBLE/WinRT.
const lamps = await scanForLampAdvertisements({ timeoutMs });
const summaries = lamps.map(({ bleDeviceId, kind, rssi, name }) => ({ bleDeviceId, kind, rssi, name }));
console.log(JSON.stringify(summaries, null, 2));

const target = lamps.find((lamp) => lamp.kind === 'unprovisioned'
  && (!requestedId || lamp.bleDeviceId === requestedId));
if (!target) {
  throw new Error(requestedId
    ? `Lampe non provisionnée introuvable : ${requestedId}`
    : 'Aucune lampe non provisionnée détectée');
}

console.log(`Ouverture GATT 0x1827 vers ${target.bleDeviceId}…`);
const startedAt = Date.now();
let connection;
try {
  connection = await openProvisioningConnection(target.device);
  console.log(`GATT 0x1827 prêt en ${Date.now() - startedAt} ms (binding de diagnostic uniquement, aucun provisioning envoyé).`);
} finally {
  await connection?.close();
  console.log('Fermeture GATT terminée ; vérification de stabilité pendant 3 s…');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log('Connexion GATT fermée proprement.');
}
