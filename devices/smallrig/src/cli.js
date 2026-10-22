#!/usr/bin/env node
// Lampes SmallRig RM75 (Bluetooth Mesh) exposées à Klixa comme un appareil LAN.
//
//   node src/cli.js run                     expose les lampes appairées au compagnon (service)
//   node src/cli.js scan                    liste les lampes à portée
//   node src/cli.js pair [--index N] [--name Nom]   appaire une lampe détectée
//   node src/cli.js list                    lampes appairées
//   node src/cli.js reconfigure <uuid>      relance la configuration d'une lampe déjà appairée
//   node src/cli.js forget <uuid> [--force] oublie une lampe (--force : sans la réinitialiser)
//   node src/cli.js status <uuid>           état et batterie d'une lampe
//
// Un seul processus doit utiliser l'état mesh à la fois : arrêtez `run` avant d'appairer ou d'oublier.
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { configureHeadlessSmallrigState } from './state-file.js';
import { createLampController } from './lamps.js';
import { createDeviceAgent } from './device-agent.js';
import { buildLightElements, createCommandHandler } from './elements.js';

const log = createLogger('cli');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
  }
  return { positional, flags };
}

function createLamps(config) {
  const meshConfig = { enabled: true, meshStateFile: config.meshStateFile, meshStateJson: '' };
  configureHeadlessSmallrigState(meshConfig, { cwd: process.cwd() });
  return createLampController({
    meshStateJson: meshConfig.meshStateJson,
    onStateChange: meshConfig.onStateChange,
    maxLamps: config.maxLamps,
    seqBlockSize: config.seqBlockSize
  });
}

const printTable = (rows) => rows.forEach((row) => console.log(row));

async function run(config) {
  if (!config.deviceToken) throw new Error('DEVICE_TOKEN manquant (à générer dans Klixa Companion → Appareils LAN)');

  const lamps = createLamps(config);
  const agent = createDeviceAgent({
    url: config.companionUrl,
    token: config.deviceToken,
    deviceId: config.deviceId,
    name: config.deviceName,
    getElements: () => buildLightElements(lamps.list()),
    onCommand: createCommandHandler(lamps)
  });

  const shutdown = async () => {
    agent.stop();
    await lamps.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`${lamps.list().length} lampe(s) appairée(s), état mesh : ${path.resolve(config.meshStateFile)}`);
  agent.start();
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'run';
  const config = loadConfig();

  if (command === 'run') return run(config);

  const lamps = createLamps(config);
  try {
    switch (command) {
      case 'list':
        printTable(lamps.list().map((lamp) => `${lamp.uuid}  ${lamp.name || ''}  [${lamp.configurationStatus}]`));
        break;

      case 'scan': {
        const found = await lamps.discover({ timeoutMs: Number(flags.timeout) || 8000 });
        printTable(found.map((lamp, index) => `${index}  ${lamp.kind}${lamp.ours ? ' (réseau actuel)' : ''}  ${lamp.name || ''}  rssi ${lamp.rssi}  ${lamp.deviceUuid || lamp.bleDeviceId}`));
        if (found.length === 0) console.log('Aucune lampe détectée.');
        break;
      }

      case 'pair': {
        const found = (await lamps.discover({ timeoutMs: Number(flags.timeout) || 8000 })).filter((lamp) => lamp.kind === 'unprovisioned');
        if (found.length === 0) throw new Error('Aucune lampe à appairer détectée (réinitialisez la lampe puis relancez).');
        const target = flags.index !== undefined ? found[Number(flags.index)] : (found.length === 1 ? found[0] : null);
        if (!target) {
          printTable(found.map((lamp, index) => `${index}  ${lamp.name || ''}  rssi ${lamp.rssi}  ${lamp.deviceUuid}`));
          throw new Error('Plusieurs lampes détectées : choisissez avec --index N.');
        }
        const result = await lamps.provision({ bleDeviceId: target.bleDeviceId, deviceUuid: target.deviceUuid, name: typeof flags.name === 'string' ? flags.name : undefined });
        console.log(`Lampe appairée : ${JSON.stringify(result)}`);
        break;
      }

      case 'reconfigure':
        console.log(JSON.stringify(await lamps.reconfigure(positional[1])));
        break;

      case 'forget':
        console.log(JSON.stringify(await lamps.forget(positional[1], { forceLocal: flags.force === true })));
        break;

      case 'status':
        console.log(JSON.stringify(await lamps.status(positional[1]), null, 2));
        break;

      default:
        throw new Error(`Commande inconnue : ${command}`);
    }
  } finally {
    await lamps.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
