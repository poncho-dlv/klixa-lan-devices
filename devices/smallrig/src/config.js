// Configuration par variables d'environnement (voir .env.example). Pur, testé.
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    // Appareil LAN : adresse du compagnon, token généré dans l'app Klixa Companion (page « Appareils LAN »)
    // pour CET identifiant d'appareil.
    companionUrl: String(env.COMPANION_URL || 'ws://127.0.0.1:8786/devices/ws').trim(),
    deviceToken: String(env.DEVICE_TOKEN || '').trim(),
    deviceId: String(env.DEVICE_ID || 'smallrig').trim(),
    deviceName: String(env.DEVICE_NAME || 'Lampes SmallRig').trim(),
    // État mesh (clés réseau, nœuds, séquences) : secret, persisté de façon atomique.
    meshStateFile: String(env.SMALLRIG_MESH_STATE_FILE || './smallrig-mesh-state.json').trim(),
    maxLamps: int(env.SMALLRIG_MAX_LAMPS, 50),
    seqBlockSize: int(env.SMALLRIG_SEQ_BLOCK_SIZE, 100)
  };
}
