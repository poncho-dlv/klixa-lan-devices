import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWrite(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* déjà fermé */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* rien à nettoyer */ }
    throw error;
  }
}

/**
 * Branche une persistance durable pour le mode headless. Sans fichier explicite,
 * toute mutation Mesh échoue avant l'émission afin d'éviter perte de DevKey ou
 * réutilisation des SEQ au prochain redémarrage.
 */
export function configureHeadlessSmallrigState(smallrigConfig, { cwd = process.cwd() } = {}) {
  if (!smallrigConfig?.enabled) return smallrigConfig;

  const configuredPath = String(smallrigConfig.meshStateFile || '').trim();
  if (!configuredPath) {
    smallrigConfig.onStateChange = async () => {
      const error = new Error('SMALLRIG_MESH_STATE_FILE est obligatoire en mode headless pour persister les clés et séquences Mesh');
      error.code = 'SMALLRIG_STATE_FILE_REQUIRED';
      throw error;
    };
    return smallrigConfig;
  }

  const file = path.resolve(cwd, configuredPath);
  try {
    fs.chmodSync(file, 0o600);
    const persisted = fs.readFileSync(file, 'utf8').trim();
    if (!persisted) {
      throw new Error('le fichier existe mais il est vide');
    }
    smallrigConfig.meshStateJson = persisted;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`État Mesh SmallRig illisible (${file}) : ${error.message}`, { cause: error });
    }
  }

  smallrigConfig.onStateChange = async (meshStateJson) => {
    atomicWrite(file, `${meshStateJson}\n`);
  };
  smallrigConfig.meshStateFile = file;
  return smallrigConfig;
}
