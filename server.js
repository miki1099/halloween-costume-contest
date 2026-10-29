import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream, rmSync } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Haloween2026';
const PHOTO_DIR = join(DATA_DIR, 'photos');
const PUBLIC_DIR = join(import.meta.dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ASSET_VERSION = Date.now().toString(36);
const MAX_ENTRIES = 200;
const ADMIN_MAX_FAILURES = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "frame-ancestors 'none'",
  ].join('; '),
};

mkdirSync(PHOTO_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'party.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS votes (
    device_id TEXT PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('phase', 'enrollment');
`);

const PHASES = ['enrollment', 'voting', 'closed'];

const getPhase = () => db.prepare(`SELECT value FROM settings WHERE key = 'phase'`).get().value;
const setPhase = (phase) => db.prepare(`UPDATE settings SET value = ? WHERE key = 'phase'`).run(phase);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendPage(res, fileName) {
  const html = readFileSync(join(PUBLIC_DIR, fileName), 'utf8').replace(
    /(href|src)="\/([a-z]+\.(?:css|js))"/g,
    `$1="/$2?v=${ASSET_VERSION}"`,
  );
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendFile(res, path, cacheControl = 'no-cache') {
  if (!existsSync(path)) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
  createReadStream(path).pipe(res);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function getDeviceId(req, res) {
  const existing = parseCookies(req).device;
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) {
    return existing;
  }
  const deviceId = randomUUID();
  res.appendHeader('Set-Cookie', `device=${deviceId}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
  return deviceId;
}

function safeEquals(given, expected) {
  const givenBuffer = Buffer.from(String(given || ''));
  const expectedBuffer = Buffer.from(expected);
  return givenBuffer.length === expectedBuffer.length && timingSafeEqual(givenBuffer, expectedBuffer);
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',').pop().trim();
  }
  return req.socket.remoteAddress;
}

const adminFailures = new Map();

function checkAdmin(req) {
  const ip = clientIp(req);
  const failure = adminFailures.get(ip);
  if (failure && failure.count >= ADMIN_MAX_FAILURES && Date.now() - failure.lastAt < ADMIN_LOCKOUT_MS) {
    throw new HttpError(429, 'Too many wrong passwords, try again in 15 minutes');
  }
  if (!safeEquals(req.headers['x-admin-password'], ADMIN_PASSWORD)) {
    const count = failure && Date.now() - failure.lastAt < ADMIN_LOCKOUT_MS ? failure.count + 1 : 1;
    adminFailures.set(ip, { count, lastAt: Date.now() });
    throw new HttpError(401, 'Wrong password');
  }
  adminFailures.delete(ip);
}


async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Photo is too large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function listEntries(deviceId) {
  return db
    .prepare(`SELECT id, name, photo, device_id FROM entries ORDER BY id`)
    .all()
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      photoUrl: `/photos/${entry.photo}`,
      mine: entry.device_id === deviceId,
    }));
}

function myVote(deviceId) {
  return db.prepare(`SELECT entry_id FROM votes WHERE device_id = ?`).get(deviceId)?.entry_id ?? null;
}

const routes = {
  'GET /api/state': (req, res, deviceId) => {
    const phase = getPhase();
    sendJson(res, 200, {
      phase,
      entries: listEntries(deviceId),
      myVote: myVote(deviceId),
    });
  },

  'POST /api/entries': async (req, res, deviceId) => {
    if (getPhase() === 'closed') {
      throw new HttpError(409, 'Voting is already closed');
    }
    const { name, photo } = await readJson(req);
    const trimmedName = String(name || '').trim().slice(0, 60);
    if (!trimmedName) {
      throw new HttpError(400, 'Please enter a name');
    }
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(photo || ''));
    if (!match) {
      throw new HttpError(400, 'Photo must be a JPEG');
    }
    const image = Buffer.from(match[1], 'base64');
    if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
      throw new HttpError(400, 'Photo must be a JPEG');
    }
    const { total, mine } = db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(device_id = ?), 0) AS mine FROM entries`)
      .get(deviceId);
    if (mine > 0) {
      throw new HttpError(409, 'You already entered the contest. Remove your photo first to add a new one');
    }
    if (total >= MAX_ENTRIES) {
      throw new HttpError(429, 'The contest is full');
    }
    const fileName = `${randomUUID()}.jpg`;
    writeFileSync(join(PHOTO_DIR, fileName), image);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO entries (name, photo, device_id) VALUES (?, ?, ?)`)
      .run(trimmedName, fileName, deviceId);
    sendJson(res, 201, { id: Number(lastInsertRowid) });
  },

  'DELETE /api/entries/mine': (req, res, deviceId) => {
    if (getPhase() !== 'enrollment') {
      throw new HttpError(409, 'Voting has started, your photo can no longer be removed');
    }
    const entry = db.prepare(`SELECT id, photo FROM entries WHERE device_id = ?`).get(deviceId);
    if (!entry) {
      throw new HttpError(404, 'You have no photo in the contest');
    }
    db.prepare(`DELETE FROM votes WHERE entry_id = ?`).run(entry.id);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(entry.id);
    rmSync(join(PHOTO_DIR, entry.photo), { force: true });
    sendJson(res, 200, { ok: true });
  },

  'POST /api/vote': async (req, res, deviceId) => {
    if (getPhase() !== 'voting') {
      throw new HttpError(409, 'Voting is not open');
    }
    const { entryId } = await readJson(req);
    const entry = db.prepare(`SELECT id, device_id FROM entries WHERE id = ?`).get(Number(entryId));
    if (!entry) {
      throw new HttpError(404, 'No such costume');
    }
    if (entry.device_id === deviceId) {
      throw new HttpError(400, 'Nice try! You cannot vote for yourself 🎃');
    }
    db.prepare(
      `INSERT INTO votes (device_id, entry_id) VALUES (?, ?)
       ON CONFLICT(device_id) DO UPDATE SET entry_id = excluded.entry_id`,
    ).run(deviceId, entry.id);
    sendJson(res, 200, { myVote: entry.id });
  },

  'GET /api/admin/results': (req, res) => {
    const entries = db
      .prepare(
        `SELECT e.id, e.name, e.photo, COUNT(v.device_id) AS votes
         FROM entries e LEFT JOIN votes v ON v.entry_id = e.id
         GROUP BY e.id ORDER BY votes DESC, e.id`,
      )
      .all()
      .map((entry) => ({ id: entry.id, name: entry.name, photoUrl: `/photos/${entry.photo}`, votes: entry.votes }));
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM votes`).get();
    sendJson(res, 200, { phase: getPhase(), totalVotes: total, entries });
  },

  'POST /api/admin/phase': async (req, res) => {
    const { phase } = await readJson(req);
    if (!PHASES.includes(phase)) {
      throw new HttpError(400, 'Unknown phase');
    }
    setPhase(phase);
    sendJson(res, 200, { phase });
  },

  'DELETE /api/admin/entries': async (req, res) => {
    const { entryId } = await readJson(req);
    db.prepare(`DELETE FROM votes WHERE entry_id = ?`).run(Number(entryId));
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(Number(entryId));
    sendJson(res, 200, { ok: true });
  },
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  try {
    if (pathname.startsWith('/api/admin/')) {
      checkAdmin(req);
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (handler) {
      const deviceId = getDeviceId(req, res);
      return await handler(req, res, deviceId);
    }
    if (req.method !== 'GET') {
      throw new HttpError(404, 'Not found');
    }
    const photo = /^\/photos\/([0-9a-f-]{36}\.jpg)$/.exec(pathname);
    if (photo) {
      return sendFile(res, join(PHOTO_DIR, photo[1]), 'private, max-age=31536000, immutable');
    }
    if (pathname === '/' || pathname === '/admin') {
      getDeviceId(req, res);
      return sendPage(res, pathname === '/' ? 'index.html' : 'admin.html');
    }
    const asset = /^\/([a-z]+\.(?:css|js|svg))$/.exec(pathname);
    if (asset) {
      return sendFile(res, join(PUBLIC_DIR, asset[1]));
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(error);
    }
    if (!res.headersSent) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Something spooky went wrong' });
    }
  }
});

server.listen(PORT, () => console.log(`Halloween party app listening on :${PORT}`));
