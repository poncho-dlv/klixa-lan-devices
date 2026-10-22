import fs from 'node:fs';
import path from 'node:path';

let logFilePath = null;

export function setLogFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  logFilePath = filePath;
}

function ts() {
  return new Date().toISOString();
}

function withoutEmoji(value) {
  return String(value)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0E\uFE0F]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function format(level, scope, msg, extra) {
  const base = `[${ts()}] ${level} [${scope}] ${withoutEmoji(msg)}`;
  if (extra === undefined) return base;
  const details = typeof extra === 'string' ? extra : JSON.stringify(extra);
  return `${base} ${withoutEmoji(details)}`;
}

function write(consoleMethod, line) {
  console[consoleMethod](line);
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, `${line}\n`); } catch { /* disque indisponible, on garde au moins la console */ }
  }
}

export function createLogger(scope) {
  return {
    info: (msg, extra) => write('log', format('INFO', scope, msg, extra)),
    warn: (msg, extra) => write('warn', format('WARN', scope, msg, extra)),
    error: (msg, extra) => write('error', format('ERROR', scope, msg, extra)),
  };
}
