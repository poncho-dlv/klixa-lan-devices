import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

if (process.platform !== 'win32') {
  throw new Error('La reconstruction native webbluetooth est réservée à Windows');
}
if (process.arch !== 'x64') {
  throw new Error(`Architecture Windows non prise en charge pour le paquet desktop : ${process.arch}`);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'node_modules', 'webbluetooth');
const cmakeJsCli = join(projectRoot, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const simpleBleRoot = join(packageRoot, 'SimpleBLE');
const nativeSource = join(packageRoot, 'SimpleBLE', 'simpleble', 'src', 'backends', 'windows', 'PeripheralBase.cpp');
const nativePatch = join(projectRoot, 'patches', 'simpleble+0.6.1+klixa-windows.patch');
const marker = 'rm75-gatt-discovery-v3';
// Fichiers touchés par nativePatch (un git diff --git a/<path> par fichier patché).
const NATIVE_PATCH_FILES = [
  'simpleble/src/backends/windows/PeripheralBase.cpp',
  'simpleble/src/backends/windows/PeripheralBase.h',
  'simpleble/src/backends/windows/Utils.h',
  'simpleble/src/backends/windows/AdapterBase.cpp',
  'simpleble/src_c/peripheral.cpp',
  'simpleble/src_c/adapter.cpp',
  'simpleble/CMakeLists.txt',
  'cmake/prelude.cmake'
];

function patchTextFile(file, transform) {
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const source = raw.replace(/\r\n/g, '\n');
  const patched = transform(source);
  if (patched === source) return;
  writeFileSync(file, patched.replace(/\n/g, eol), 'utf8');
}

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Source webbluetooth inattendue (${label})`);
  return source.replace(before, after);
}

function nativePatchAlreadyApplied() {
  const source = readFileSync(nativeSource, 'utf8');
  return source.includes('GetGattServicesForUuidAsync') && source.includes('_cleanup_gatt() noexcept');
}

function applyNativePatch() {
  if (nativePatchAlreadyApplied()) return;

  // node_modules est listé dans .gitignore. Appliqué depuis simpleBleRoot, `git apply`
  // remonte jusqu'au dépôt klixa-companion, reconnaît le chemin cible comme ignoré, et
  // selon la version de Git, applique le patch en silence sans écrire les hunks (succès
  // signalé à tort) ou échoue purement et simplement — les deux constatés en pratique
  // (localement puis en CI) pour ce même patch. Plutôt que de dépendre d'un réglage Git
  // (GIT_CEILING_DIRECTORIES, core.autocrlf, etc.) pour contourner ce comportement lié à
  // .gitignore, on copie les fichiers concernés dans un répertoire temporaire hors de
  // tout dépôt Git, on y applique le patch sans ambiguïté possible, puis on les recopie.
  const stagingDir = mkdtempSync(join(tmpdir(), 'klixa-simpleble-'));
  try {
    for (const relativePath of NATIVE_PATCH_FILES) {
      const dest = join(stagingDir, relativePath);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(simpleBleRoot, relativePath), dest);
    }

    const apply = spawnSync('git', ['apply', nativePatch], {
      cwd: stagingDir,
      encoding: 'utf8',
      windowsHide: true
    });
    if (apply.error) throw apply.error;
    assert.equal(apply.status, 0, `Application du patch SimpleBLE échouée : ${apply.stderr || apply.stdout}`);

    for (const relativePath of NATIVE_PATCH_FILES) {
      copyFileSync(join(stagingDir, relativePath), join(simpleBleRoot, relativePath));
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  assert.ok(nativePatchAlreadyApplied(), 'Le patch natif SimpleBLE a été appliqué mais le marqueur attendu reste absent');
}

applyNativePatch();

// SimpleBLE est livré comme sous-module Git dans le paquet npm : patch-package ne
// sait pas représenter son mode 160000. Le build applique donc ces trois changements
// source de façon déterministe et échoue si l'upstream 3.7.0 ne correspond plus.
patchTextFile(nativeSource, (source) => {
  if (source.includes('GetGattServicesForUuidAsync') && source.includes('_cleanup_gatt() noexcept')) {
    return source;
  }
  source = replaceRequired(
    source,
    '#include <iostream>\n',
    '#include <iostream>\n#include <thread>\n',
    'temporisation WinRT'
  );
  source = replaceRequired(
    source,
    `    for (size_t i = 0; i < 3; i++) {
        if (_attempt_connect()) {
            break;
        }
    }`,
    `    for (size_t i = 0; i < 3; i++) {
        if (_attempt_connect()) {
            break;
        }
        // WinRT can report ConnectionStatus::Connected before the remote GATT
        // database is ready. Immediate retries repeat the same Unreachable result.
        if (i + 1 < 3) std::this_thread::sleep_for(1000ms);
    }`,
    'délai entre découvertes GATT'
  );
  source = replaceRequired(
    source,
    `    auto services_result = async_get(device_.GetGattServicesAsync(BluetoothCacheMode::Uncached));
    if (services_result.Status() != GattCommunicationStatus::Success) {
        return false;
    }

    auto gatt_services = services_result.Services();`,
    `    auto services_result = async_get(device_.GetGattServicesAsync(BluetoothCacheMode::Uncached));
    if (services_result.Status() != GattCommunicationStatus::Success || services_result.Services().Size() == 0) {
        // The uncached request initiates the physical link. Once WinRT reports the
        // link connected, its cached view is often populated before a second
        // uncached transaction succeeds, especially for unpaired PB-GATT devices.
        std::this_thread::sleep_for(500ms);
        services_result = async_get(device_.GetGattServicesAsync(BluetoothCacheMode::Cached));
    }
    if (services_result.Status() != GattCommunicationStatus::Success || services_result.Services().Size() == 0) {
        return false;
    }

    auto gatt_services = services_result.Services();`,
    'secours cache des services GATT'
  );
  const characteristicsFallback = `        auto characteristics_result = async_get(service.GetCharacteristicsAsync(BluetoothCacheMode::Uncached));
        if (characteristics_result.Status() != GattCommunicationStatus::Success || characteristics_result.Characteristics().Size() == 0) {
            std::this_thread::sleep_for(250ms);
            characteristics_result = async_get(service.GetCharacteristicsAsync(BluetoothCacheMode::Cached));
        }
        if (characteristics_result.Status() != GattCommunicationStatus::Success || characteristics_result.Characteristics().Size() == 0) {
            // A secondary service can transiently refuse discovery while the Mesh
            // Provisioning/Proxy service remains usable.
            continue;
        }`;
  if (!source.includes(characteristicsFallback)) {
    const upstreamCharacteristics = `        auto characteristics_result = async_get(service.GetCharacteristicsAsync(BluetoothCacheMode::Uncached));
        if (characteristics_result.Status() != GattCommunicationStatus::Success) {
            return false;
        }`;
    const v1Characteristics = `        auto characteristics_result = async_get(service.GetCharacteristicsAsync(BluetoothCacheMode::Uncached));
        if (characteristics_result.Status() != GattCommunicationStatus::Success) {
            // A secondary service can transiently refuse discovery while the Mesh
            // Provisioning/Proxy service remains usable. Keep the successful service
            // graph instead of invalidating the complete connection.
            continue;
        }`;
    if (source.includes(v1Characteristics)) {
      source = source.replace(v1Characteristics, characteristicsFallback);
    } else {
      source = replaceRequired(source, upstreamCharacteristics, characteristicsFallback, 'secours cache des caractéristiques GATT');
    }
  }
  source = replaceRequired(
    source,
    `        // Save the MTU size
        mtu_ = service.Session().MaxPduSize();`,
    `        // Keep the WinRT session alive for the whole SimpleBLE connection.
        // This prevents Windows from dropping an unpaired PB-GATT link between
        // service discovery and characteristic discovery.
        auto session = service.Session();
        session.MaintainConnection(true);

        // Save the MTU size
        mtu_ = session.MaxPduSize();`,
    'maintien de session GATT'
  );
  if (!source.includes('if (descriptors_result.Status() == GattCommunicationStatus::Success)')) {
    source = replaceRequired(
      source,
      `            if (descriptors_result.Status() != GattCommunicationStatus::Success) {
                return false;
            }

            // Load the descriptors into the characteristic
            auto gatt_descriptors = descriptors_result.Descriptors();
            for (GattDescriptor&& descriptor : gatt_descriptors) {
                // For each descriptor...
                gatt_descriptor_t gatt_descriptor;
                gatt_descriptor.obj = descriptor;

                // Fetch the descriptor UUID.
                std::string descriptor_uuid = guid_to_uuid(descriptor.Uuid());

                // Append the descriptor to the characteristic.
                gatt_characteristic.descriptors.emplace(descriptor_uuid, std::move(gatt_descriptor));
            }`,
      `            if (descriptors_result.Status() == GattCommunicationStatus::Success) {
                // Descriptor enumeration is optional for Klixa: WinRT configures the
                // CCCD directly when subscribing. Keep an otherwise usable service.
                auto gatt_descriptors = descriptors_result.Descriptors();
                for (GattDescriptor&& descriptor : gatt_descriptors) {
                    // For each descriptor...
                    gatt_descriptor_t gatt_descriptor;
                    gatt_descriptor.obj = descriptor;

                    // Fetch the descriptor UUID.
                    std::string descriptor_uuid = guid_to_uuid(descriptor.Uuid());

                    // Append the descriptor to the characteristic.
                    gatt_characteristic.descriptors.emplace(descriptor_uuid, std::move(gatt_descriptor));
                }
            }`,
      'découverte des descripteurs'
    );
  }
  const functionStart = source.indexOf('bool PeripheralBase::_attempt_connect()');
  const functionEnd = source.indexOf('\ngatt_characteristic_t& PeripheralBase::_fetch_characteristic', functionStart);
  if (functionStart === -1 || functionEnd === -1) throw new Error('Source webbluetooth inattendue (_attempt_connect)');
  const body = source.slice(functionStart, functionEnd);
  const patchedBody = replaceRequired(body, '    return true;\n}', '    return !gatt_map_.empty();\n}', 'résultat GATT');
  return source.slice(0, functionStart) + patchedBody + source.slice(functionEnd);
});

for (const cmakeFile of [
  join(packageRoot, 'SimpleBLE', 'simpleble', 'CMakeLists.txt'),
  join(packageRoot, 'SimpleBLE', 'cmake', 'prelude.cmake')
]) {
  patchTextFile(cmakeFile, (source) => source.includes('cmake_minimum_required(VERSION 3.20)')
    ? source
    : replaceRequired(
      source,
      'cmake_minimum_required(VERSION 3.21)',
      'cmake_minimum_required(VERSION 3.20)',
      'version minimale CMake'
    ));
}

patchTextFile(join(packageRoot, 'lib', 'bindings.cpp'), (source) => {
  if (source.includes(`exports.Set("klixaPatchVersion", Napi::String::New(env, "${marker}"))`)) return source;
  if (source.includes('rm75-gatt-discovery-v1') || source.includes('rm75-gatt-discovery-v2')) {
    return source.replace(/rm75-gatt-discovery-v[12]/, marker);
  }
  return replaceRequired(
    source,
    '  exports.Set("isEnabled", Napi::Function::New(env, IsEnabled));',
    `  exports.Set("isEnabled", Napi::Function::New(env, IsEnabled));
  // Runtime marker proving that the tolerant WinRT GATT discovery was compiled.
  exports.Set("klixaPatchVersion", Napi::String::New(env, "${marker}"));`,
    'marqueur du binding natif'
  );
});

assert.ok(
  readFileSync(nativeSource, 'utf8').includes('GetGattServicesForUuidAsync')
    && readFileSync(nativeSource, 'utf8').includes('_cleanup_gatt() noexcept')
    && readFileSync(join(simpleBleRoot, 'simpleble', 'src_c', 'peripheral.cpp'), 'utf8')
      .includes('std::min(service.data().size(), sizeof(services->data))')
    && readFileSync(join(simpleBleRoot, 'simpleble', 'src', 'backends', 'windows', 'Utils.h'), 'utf8')
      .includes('async.Status() == Foundation::AsyncStatus::Started'),
  'Le patch natif v3 de découverte et teardown GATT doit être appliqué avant la compilation'
);

function findCmake() {
  const fromPath = spawnSync('where.exe', ['cmake.exe'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const pathCandidate = fromPath.status === 0
    ? fromPath.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean)
    : null;
  if (pathCandidate && existsSync(pathCandidate)) return pathCandidate;

  const roots = [...new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean))];
  const versions = ['18', '2022', '2019'];
  const editions = ['BuildTools', 'Enterprise', 'Professional', 'Community'];
  for (const root of roots) {
    for (const version of versions) {
      for (const edition of editions) {
        const candidate = join(
          root,
          'Microsoft Visual Studio',
          version,
          edition,
          'Common7',
          'IDE',
          'CommonExtensions',
          'Microsoft',
          'CMake',
          'CMake',
          'bin',
          'cmake.exe'
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const args = [
  cmakeJsCli,
  'compile',
  '--config', 'Release',
  '--runtime', 'node',
  '--runtime-version', process.versions.node,
  '--arch', 'x64'
];
const cmakePath = findCmake();
if (cmakePath) args.push('--cmake-path', cmakePath);

const build = spawnSync(process.execPath, args, {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
  timeout: 15 * 60 * 1000,
  windowsHide: true
});
if (build.error) throw build.error;
assert.equal(build.status, 0, `Compilation native webbluetooth échouée${build.signal ? ` (${build.signal})` : ''}`);

const compiled = join(packageRoot, 'build', 'Release', 'simpleble.node');
const target = join(packageRoot, 'prebuilds', 'klixa-simpleble-win32-x64', 'node-napi-v6.node');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(compiled, target);

const require = createRequire(import.meta.url);
const addon = require(target);
assert.equal(addon.klixaPatchVersion, marker, 'Le binding recompilé ne contient pas le marqueur du correctif Klixa');
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
console.log(`Binding webbluetooth Windows corrigé installé (${sha256})`);
