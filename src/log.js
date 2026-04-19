import { appendFileSync, statSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

const MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 10 * 1024 * 1024; // 10 MB
const KEEP_ROTATED = Number(process.env.LOG_KEEP_ROTATED) || 5;

const logFilePath = process.env.LOG_FILE || null;
let writesSinceSizeCheck = 0;
const SIZE_CHECK_EVERY = 200;

function setLevel(level) {
  if (LEVELS[level] !== undefined) {
    minLevel = LEVELS[level];
  }
}

function fmt(level, tag, msg, extra) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (extra !== undefined) {
    return `${base} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  }
  return base;
}

function rotateIfNeeded() {
  if (!logFilePath) return;
  try {
    if (!existsSync(logFilePath)) return;
    const size = statSync(logFilePath).size;
    if (size < MAX_BYTES) return;

    const dir = dirname(logFilePath);
    const base = basename(logFilePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rotated = join(dir, `${base}.${timestamp}`);
    renameSync(logFilePath, rotated);

    // Clean up older rotations beyond KEEP_ROTATED
    const rotations = readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f !== base)
      .sort();
    const toDelete = rotations.slice(0, Math.max(0, rotations.length - KEEP_ROTATED));
    for (const f of toDelete) {
      try { unlinkSync(join(dir, f)); } catch {}
    }

    write(fmt('info', 'log', `Rotated log (size=${size} bytes → ${rotated}; kept last ${KEEP_ROTATED})`));
  } catch {
    // Rotation failures are non-fatal; keep writing to original file.
  }
}

function write(line) {
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n');
      if (++writesSinceSizeCheck >= SIZE_CHECK_EVERY) {
        writesSinceSizeCheck = 0;
        rotateIfNeeded();
      }
      return;
    } catch {
      // Fall through to console on write failure
    }
  }
  console.log(line);
}

function makeLogger(tag) {
  return {
    debug: (msg, extra) => { if (minLevel <= LEVELS.debug) write(fmt('debug', tag, msg, extra)); },
    info:  (msg, extra) => { if (minLevel <= LEVELS.info)  write(fmt('info', tag, msg, extra)); },
    warn:  (msg, extra) => { if (minLevel <= LEVELS.warn)  write(fmt('warn', tag, msg, extra)); },
    error: (msg, extra) => { if (minLevel <= LEVELS.error) write(fmt('error', tag, msg, extra)); },
  };
}

export { makeLogger, setLevel, rotateIfNeeded };
