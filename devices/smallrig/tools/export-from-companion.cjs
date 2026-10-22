// Export UNIQUE de l'état mesh SmallRig depuis l'app Klixa Companion (version ≤ 0.5.x) vers un fichier
// utilisable par ce script (devices/smallrig de klixa-lan-devices), SANS ré-appairer les lampes.
//
// L'état est chiffré par Electron (safeStorage / DPAPI) dans `config.json` du dossier de données de
// l'app : seul un processus Electron du même utilisateur Windows peut le déchiffrer. Lancez donc CE
// script avec Electron (fermez d'abord l'app Klixa Companion) :
//
//   cd ../klixa-companion
//   npx electron ../klixa-lan-devices/devices/smallrig/tools/export-from-companion.cjs --out=../klixa-lan-devices/devices/smallrig/smallrig-mesh-state.json
//
// Options : --out=<fichier> (défaut ./smallrig-mesh-state.json dans le dossier courant),
//           --user-data=<dossier> (défaut %APPDATA%/klixa-companion ou « Klixa Companion »).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');

function defaultUserData() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  // Le nom du dossier suit le `productName` d'electron-builder, sinon le `name` du package.
  for (const name of ['Klixa Companion', 'klixa-companion']) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, 'config.json'))) return candidate;
  }
  return path.join(base, 'Klixa Companion');
}

app.whenReady().then(() => {
  try {
    const option = (name) => (process.argv.find((arg) => arg.startsWith(`--${name}=`)) || '').slice(name.length + 3);
    const userData = option('user-data') ? path.resolve(option('user-data')) : defaultUserData();
    const output = path.resolve(option('out') || 'smallrig-mesh-state.json');
    const configFile = path.join(userData, 'config.json');

    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')).SMALLRIG_MESH_STATE;
    if (!stored) throw new Error(`Aucun état SmallRig dans ${configFile}`);

    let json = stored;
    if (stored.startsWith('encrypted:')) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Stockage sécurisé indisponible');
      json = safeStorage.decryptString(Buffer.from(stored.slice('encrypted:'.length), 'base64'));
    }

    JSON.parse(json); // vérifie que le contenu est bien du JSON avant d'écrire
    fs.writeFileSync(output, `${json.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(`État mesh exporté vers ${output}`);
    app.exit(0);
  } catch (error) {
    console.error(`Export impossible : ${error.message}`);
    app.exit(1);
  }
});
