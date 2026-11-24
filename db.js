"use strict";

/* =========================================================================
   Datenschicht von Travelfy - SQLite ueber das eingebaute Modul node:sqlite.
   Keine externen Abhaengigkeiten, keine native Kompilierung.

   Eigene Datenbankdatei (travelfy.sqlite), eigene Benutzer, eigene
   Sitzungen - nichts davon wird mit einer anderen Anwendung geteilt.

   Stationen und Bilder haengen per Fremdschluessel an der Reise und werden
   beim Loeschen mit entfernt (CASCADE). Bilder liegen als BLOB in der
   Datenbank und werden ueber eine eigene URL ausgeliefert.
   ========================================================================= */

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;
// Kennung dieser Anwendung in der Datenbank: eine fremde Datenbankdatei
// (z.B. die des Kochbuchs) wird beim Start abgelehnt statt still benutzt.
const APP_ID = "travelfy";

// Vorschlaege fuer die Reiseart (hoechstens eine je Reise). Eigene Eingaben
// sind erlaubt; der Client bekommt diese Liste plus alle schon benutzten.
const CATEGORY_OPTIONS = [
  "Städtereise", "Strandurlaub", "Wandern & Berge", "Rundreise", "Roadtrip",
  "Kreuzfahrt", "Camping", "Skiurlaub", "Kulturreise", "Wellness",
  "Abenteuer", "Geschäftsreise",
];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB pro Bild

/** Fehler mit HTTP-Statuscode - die API uebersetzt ihn direkt in die Antwort. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let db = null;

/* ---------------------------------------------------------------- Schema */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Benutzer. Rolle: 'admin' (genau einer, fest id 0), 'rw' (lesen + schreiben),
-- 'r' (nur lesen). Der CHECK erzwingt: id 0 <=> admin.
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'rw', 'r')),
  created_at    TEXT NOT NULL,
  CHECK ((id = 0) = (role = 'admin'))
);

-- Gespeichert wird nur der SHA-256 des Tokens, nie das Token selbst.
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions(account_id);

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_desc  TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  start_date  TEXT NOT NULL DEFAULT '',
  end_date    TEXT NOT NULL DEFAULT '',
  long_text   TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Reiseart: hoechstens eine je Reise (prueft normalizeCategories).
CREATE TABLE IF NOT EXISTS trip_categories (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trip_categories_trip ON trip_categories(trip_id, position);

-- Stationen der Reise (Ort + Datum/Notiz), Reihenfolge ueber position.
CREATE TABLE IF NOT EXISTS stations (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stations_trip ON stations(trip_id, position);

CREATE TABLE IF NOT EXISTS images (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name     TEXT NOT NULL DEFAULT '',
  mime     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  data     BLOB NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_trip ON images(trip_id, position);
`;

/**
 * Oeffnet die Datenbank und bringt das Schema auf Stand. Fehlt der Admin,
 * wird er angelegt; generatedAdminPassword ist dann sein Startpasswort
 * (zufaellig, falls options.adminPassword fehlt), sonst null.
 */
function open(file, options = {}) {
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Fremde Datenbank? Eine Datei mit Tabellen, aber ohne Travelfy-Kennung
  // gehoert einer anderen Anwendung - nicht anfassen.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  if (tables.length > 0) {
    const appRow = tables.includes("meta")
      ? db.prepare("SELECT value FROM meta WHERE key = 'app'").get()
      : null;
    if (!appRow || appRow.value !== APP_ID) {
      db.close();
      db = null;
      throw new Error(`Die Datei ${file} ist keine Travelfy-Datenbank (gehoert einer anderen Anwendung).`);
    }
  }

  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('app', ?)").run(APP_ID);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) > SCHEMA_VERSION) {
    throw new Error(`Datenbank hat Schema-Version ${row.value}, dieser Server kennt nur ${SCHEMA_VERSION}.`);
  }

  const generatedAdminPassword = ensureAdmin(options.adminPassword);
  db.prepare("DELETE FROM account_sessions WHERE expires_at < ?").run(nowIso());
  return { generatedAdminPassword };
}

function close() {
  if (db) db.close();
  db = null;
}

/* ------------------------------------------------------------- Helfer */

function makeId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

/** Laeuft fn in einer Transaktion; bei jedem Fehler wird komplett zurueckgerollt. */
function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* Rollback-Fehler nicht ueberdecken */ }
    throw err;
  }
}

function text(value, field, { max = 10000, required = false } = {}) {
  const str = value == null ? "" : String(value);
  const trimmed = str.trim();
  if (required && !trimmed) throw new HttpError(400, `Feld "${field}" darf nicht leer sein.`);
  if (str.length > max) {
    throw new HttpError(400, `Feld "${field}" ist zu lang (max. ${max} Zeichen).`);
  }
  return required ? trimmed : str;
}

/** Datum als JJJJ-MM-TT oder leer. */
function isoDate(value, field) {
  const str = value == null ? "" : String(value).trim();
  if (!str) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(str))) {
    throw new HttpError(400, `Feld "${field}" muss ein Datum im Format JJJJ-MM-TT sein.`);
  }
  return str;
}

/** Zerlegt "data:image/png;base64,..." in MIME-Typ und Binaerdaten. */
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new HttpError(400, "Neues Bild ohne Daten - Feld \"dataUrl\" fehlt.");
  }
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp));base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) {
    throw new HttpError(415, "Nur Bilder (PNG, JPEG, GIF, WebP, AVIF, BMP) als Base64-Data-URL werden akzeptiert.");
  }
  const buf = Buffer.from(match[2], "base64");
  if (buf.length === 0) throw new HttpError(400, "Bilddaten sind leer.");
  if (buf.length > MAX_IMAGE_BYTES) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new HttpError(413, `Bild ist zu gross (${mb(buf.length)} MB), erlaubt sind ${mb(MAX_IMAGE_BYTES)} MB.`);
  }
  return { mime: match[1], buf };
}

/* -------------------------------------------------------------- Reisen */

const TRIP_SORT_COLUMNS = {
  name: "t.name COLLATE NOCASE",
  destination: "t.destination COLLATE NOCASE",
  startDate: "t.start_date",
  updatedAt: "t.updated_at",
  createdBy: "a.username COLLATE NOCASE",
};
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Wert fuer den Reiseart-Filter "ohne Reiseart". */
const NO_CATEGORY = "-";

/** Escaped % und _ (LIKE-Platzhalter) sowie das Escape-Zeichen selbst. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * WHERE der Uebersicht. Die Suche prueft Name, Kurzbeschreibung, Reiseziel,
 * Stationen, Reiseart und Benutzername. Tabellenalias im Aufrufer: t.
 */
function buildSearchWhere(term, ownerId = null, filters = {}) {
  const conditions = [];
  const params = [];
  if (term) {
    const like = `%${escapeLike(term)}%`;
    conditions.push(`(t.name LIKE ? ESCAPE '\\'
       OR t.short_desc LIKE ? ESCAPE '\\'
       OR t.destination LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM stations ss WHERE ss.trip_id = t.id AND ss.name LIKE ? ESCAPE '\\')
       OR EXISTS (SELECT 1 FROM trip_categories sc WHERE sc.trip_id = t.id AND sc.name LIKE ? ESCAPE '\\')
       OR EXISTS (SELECT 1 FROM accounts sa WHERE sa.id = t.created_by AND sa.username LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like, like, like, like);
  }
  const category = filters.category == null ? "" : String(filters.category).trim();
  if (category === NO_CATEGORY) {
    conditions.push("NOT EXISTS (SELECT 1 FROM trip_categories fc WHERE fc.trip_id = t.id)");
  } else if (category) {
    conditions.push("EXISTS (SELECT 1 FROM trip_categories fc WHERE fc.trip_id = t.id AND fc.name = ? COLLATE NOCASE)");
    params.push(category);
  }
  if (filters.createdBy != null && filters.createdBy !== "") {
    const createdBy = Math.trunc(Number(filters.createdBy));
    if (!Number.isFinite(createdBy)) throw new HttpError(400, 'Feld "createdBy" muss eine Benutzer-id sein.');
    conditions.push("t.created_by = ?");
    params.push(createdBy);
  }
  // Nur Reisen, die an oder nach diesem Tag beginnen (Seitenleiste "Naechste Reisen").
  const fromDate = isoDate(filters.fromDate, "fromDate");
  if (fromDate) {
    conditions.push("t.start_date >= ?");
    params.push(fromDate);
  }
  if (ownerId !== null) {
    conditions.push("t.created_by = ?");
    params.push(ownerId);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

/** Uebersicht mit Suche, Sortierung und Seitenteilung - alles in SQL. */
function listTripsPage(options = {}) {
  const sortBy = TRIP_SORT_COLUMNS[options.sortBy] ? options.sortBy : "name";
  const sortDir = options.sortDir === "desc" ? "DESC" : "ASC";
  const term = text(options.search, "search", { max: 100 }).trim();
  const page = Math.max(1, Math.trunc(Number(options.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(options.pageSize)) || DEFAULT_PAGE_SIZE));

  const { where, params } = buildSearchWhere(term, options.ownerId ?? null, {
    category: options.category,
    createdBy: options.createdBy,
    fromDate: options.fromDate,
  });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM trips t ${where}`).get(...params).n;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const items = db.prepare(`
    SELECT t.id, t.name, t.short_desc AS shortDesc, t.destination,
           t.start_date AS startDate, t.end_date AS endDate, t.updated_at AS updatedAt,
           a.username AS createdByName,
           (SELECT name FROM trip_categories c WHERE c.trip_id = t.id ORDER BY position LIMIT 1) AS category,
           (SELECT COUNT(*) FROM stations s WHERE s.trip_id = t.id) AS stationCount,
           (SELECT COUNT(*) FROM images g   WHERE g.trip_id = t.id) AS imageCount
    FROM trips t
    LEFT JOIN accounts a ON a.id = t.created_by
    ${where}
    ORDER BY ${TRIP_SORT_COLUMNS[sortBy]} ${sortDir}, t.id ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return { items, total, page: safePage, pageSize, totalPages };
}

/** Auswahl fuer die Filter der Uebersicht - nur was im sichtbaren Bestand vorkommt. */
function listTripFilters(ownerId = null) {
  const scope = ownerId === null ? "" : "WHERE t.created_by = ?";
  const params = ownerId === null ? [] : [ownerId];
  const categories = db.prepare(`
    SELECT DISTINCT c.name FROM trip_categories c JOIN trips t ON t.id = c.trip_id
    ${scope} ORDER BY c.name COLLATE NOCASE
  `).all(...params).map((row) => row.name);
  const owners = db.prepare(`
    SELECT DISTINCT a.id, a.username FROM trips t JOIN accounts a ON a.id = t.created_by
    ${scope} ORDER BY a.username COLLATE NOCASE
  `).all(...params).map((row) => ({ id: row.id, username: row.username }));
  const withoutCategory = db.prepare(`
    SELECT COUNT(*) AS n FROM trips t
    WHERE ${ownerId === null ? "" : "t.created_by = ? AND "}NOT EXISTS (SELECT 1 FROM trip_categories c WHERE c.trip_id = t.id)
  `).get(...params).n > 0;
  return { categories, owners, withoutCategory };
}

function getTrip(id) {
  const trip = db.prepare(`
    SELECT t.id, t.name, t.short_desc AS shortDesc, t.destination,
           t.start_date AS startDate, t.end_date AS endDate, t.long_text AS longText,
           t.created_at AS createdAt, t.updated_at AS updatedAt,
           t.created_by AS createdBy, a.username AS createdByName
    FROM trips t LEFT JOIN accounts a ON a.id = t.created_by
    WHERE t.id = ?
  `).get(id);
  if (!trip) return null;

  trip.stations = db.prepare(`
    SELECT id, name, note FROM stations WHERE trip_id = ? ORDER BY position
  `).all(id);

  trip.categories = db.prepare(`
    SELECT name FROM trip_categories WHERE trip_id = ? ORDER BY position
  `).all(id).map((c) => c.name);

  // Bewusst ohne Spalte "data" - die Bytes kommen ueber GET /api/images/:id.
  trip.images = db.prepare(`
    SELECT id, name, mime, bytes FROM images WHERE trip_id = ? ORDER BY position
  `).all(id).map((img) => ({ ...img, url: `api/images/${img.id}` }));

  return trip;
}

function writeStations(tripId, stations) {
  db.prepare("DELETE FROM stations WHERE trip_id = ?").run(tripId);
  const insert = db.prepare(
    "INSERT INTO stations (id, trip_id, name, note, position) VALUES (?, ?, ?, ?, ?)"
  );
  stations.forEach((st, index) => {
    const name = text(st && st.name, "stations[].name", { max: 80 });
    if (!name.trim()) return; // leere Zeilen still verwerfen
    insert.run(makeId(), tripId, name.trim(), text(st.note, "stations[].note", { max: 60 }).trim(), index);
  });
}

function writeCategories(tripId, categories) {
  db.prepare("DELETE FROM trip_categories WHERE trip_id = ?").run(tripId);
  const insert = db.prepare(
    "INSERT INTO trip_categories (id, trip_id, name, position) VALUES (?, ?, ?, ?)"
  );
  categories.forEach((name, index) => insert.run(makeId(), tripId, name, index));
}

function writeImages(tripId, images) {
  // Der Client schickt fuer bestehende Bilder nur die id, die Bytes liegen allein hier.
  const existing = new Set(
    db.prepare("SELECT id FROM images WHERE trip_id = ?").all(tripId).map((r) => r.id)
  );
  const kept = new Set();
  for (const img of images) {
    if (img && img.id && existing.has(img.id)) kept.add(img.id);
  }

  const remove = db.prepare("DELETE FROM images WHERE id = ?");
  for (const id of existing) {
    if (!kept.has(id)) remove.run(id);
  }

  const reposition = db.prepare("UPDATE images SET position = ?, name = ? WHERE id = ?");
  const insert = db.prepare(
    "INSERT INTO images (id, trip_id, name, mime, bytes, data, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  images.forEach((img, index) => {
    const name = text(img && img.name, "images[].name", { max: 200 });
    if (img && img.id && kept.has(img.id)) {
      reposition.run(index, name, img.id);
    } else {
      const { mime, buf } = decodeDataUrl(img && img.dataUrl);
      insert.run(makeId(), tripId, name, mime, buf.length, buf, index);
    }
  });
}

function normalizeTripInput(input) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Reise-Daten fehlen oder sind kein Objekt.");
  }
  const stations = input.stations == null ? [] : input.stations;
  const images = input.images == null ? [] : input.images;
  if (!Array.isArray(stations)) throw new HttpError(400, 'Feld "stations" muss eine Liste sein.');
  if (!Array.isArray(images)) throw new HttpError(400, 'Feld "images" muss eine Liste sein.');
  const startDate = isoDate(input.startDate, "startDate");
  const endDate = isoDate(input.endDate, "endDate");
  if (startDate && endDate && endDate < startDate) {
    throw new HttpError(400, "Das Enddatum liegt vor dem Startdatum.");
  }
  return {
    name: text(input.name, "name", { max: 80, required: true }),
    shortDesc: text(input.shortDesc, "shortDesc", { max: 150 }).trim(),
    destination: text(input.destination, "destination", { max: 80 }).trim(),
    startDate,
    endDate,
    longText: text(input.longText, "longText", { max: 20000 }),
    categories: normalizeCategories(input.categories),
    stations,
    images,
  };
}

/** Reiseart: Liste mit hoechstens einem Text (leer = keine Reiseart). */
function normalizeCategories(list) {
  if (list == null) list = [];
  if (!Array.isArray(list)) throw new HttpError(400, 'Feld "categories" muss eine Liste sein.');
  const seen = new Set();
  const result = [];
  for (const value of list) {
    const name = text(value, "categories[]", { max: 40 }).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  if (result.length > 1) throw new HttpError(400, "Eine Reise kann nur eine Reiseart haben.");
  return result;
}

function createTrip(input, accountId) {
  const data = normalizeTripInput(input);
  const id = makeId();
  return transaction(() => {
    const ts = nowIso();
    db.prepare(`
      INSERT INTO trips (id, name, short_desc, destination, start_date, end_date, long_text, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.shortDesc, data.destination, data.startDate, data.endDate, data.longText, accountId, ts, ts);
    writeCategories(id, data.categories);
    writeStations(id, data.stations);
    writeImages(id, data.images);
    return getTrip(id);
  });
}

function updateTrip(id, input) {
  const data = normalizeTripInput(input);
  return transaction(() => {
    if (!db.prepare("SELECT 1 FROM trips WHERE id = ?").get(id)) {
      throw new HttpError(404, `Reise "${id}" nicht gefunden.`);
    }
    db.prepare(`
      UPDATE trips SET name = ?, short_desc = ?, destination = ?, start_date = ?, end_date = ?,
                       long_text = ?, updated_at = ?
      WHERE id = ?
    `).run(data.name, data.shortDesc, data.destination, data.startDate, data.endDate, data.longText, nowIso(), id);
    writeCategories(id, data.categories);
    writeStations(id, data.stations);
    writeImages(id, data.images);
    return getTrip(id);
  });
}

function deleteTrip(id) {
  // Stationen und Bilder verschwinden per ON DELETE CASCADE mit.
  return db.prepare("DELETE FROM trips WHERE id = ?").run(id).changes > 0;
}

/* -------------------------------------------------------------- Bilder */

function getImage(id) {
  return db.prepare("SELECT id, trip_id AS tripId, name, mime, bytes, data FROM images WHERE id = ?").get(id) || null;
}

/* --------------------------------------------------------------- Stand */

/** Vorschlaege fuer die Reiseart: die feste Liste plus alle schon benutzten. */
function listCategoryOptions() {
  const options = [...CATEGORY_OPTIONS];
  const known = new Set(options.map((c) => c.toLowerCase()));
  const used = db.prepare("SELECT DISTINCT name FROM trip_categories ORDER BY name COLLATE NOCASE").all();
  for (const { name } of used) {
    if (!known.has(name.toLowerCase())) {
      known.add(name.toLowerCase());
      options.push(name);
    }
  }
  return options;
}

function getStats() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    trips: one("SELECT COUNT(*) AS n FROM trips"),
    stations: one("SELECT COUNT(*) AS n FROM stations"),
    images: one("SELECT COUNT(*) AS n FROM images"),
    imageBytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM images").get().n,
    accounts: one("SELECT COUNT(*) AS n FROM accounts"),
  };
}

/* ------------------------------------------------------------ Benutzer */

const ADMIN_ID = 0;
// Name des festen Admins - eine Aenderung hier benennt ihn beim naechsten Start um.
const ADMIN_USERNAME = "stefan";
const SESSION_DAYS = 30;
const SESSION_RENEW_DAYS = 15;
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Passwort-Hash im Format scrypt$N$r$p$salz$hash (beides Base64). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Fuer unbekannte Benutzernamen wird trotzdem ein Hash geprueft, damit die
// Antwortzeit nicht verraet, ob es den Namen gibt.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

function normalizeUsername(value) {
  const name = text(value, "Benutzername", { max: 40, required: true });
  if (name.length < 2) throw new HttpError(400, "Der Benutzername braucht mindestens 2 Zeichen.");
  if (!/^[\p{L}\p{N}._ -]+$/u.test(name)) {
    throw new HttpError(400, "Der Benutzername darf nur Buchstaben, Ziffern, Leerzeichen sowie . _ - enthalten.");
  }
  return name;
}

function validatePassword(value) {
  const password = value == null ? "" : String(value);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`);
  }
  if (password.length > 200) throw new HttpError(400, "Das Passwort ist zu lang (max. 200 Zeichen).");
  return password;
}

/** Rollen, die die Benutzerverwaltung vergeben darf - "admin" gibt es nur einmal, fest. */
function normalizeRole(value) {
  if (value !== "rw" && value !== "r") {
    throw new HttpError(400, 'Rolle muss "rw" (lesen und schreiben) oder "r" (nur lesen) sein.');
  }
  return value;
}

function publicAccount(row) {
  return row ? { id: row.id, username: row.username, role: row.role } : null;
}

function canWrite(account) {
  return !!account && (account.role === "admin" || account.role === "rw");
}

/** Admin und "r" sehen alle Reisen, "rw" nur die selbst angelegten (Besitzer-id oder null = alle). */
function tripOwnerFilter(account) {
  return account && account.role === "rw" ? account.id : null;
}

function canAccessTrip(account, tripId) {
  const row = db.prepare("SELECT created_by AS createdBy FROM trips WHERE id = ?").get(tripId);
  if (!row) return false;
  const ownerId = tripOwnerFilter(account);
  return ownerId === null || row.createdBy === ownerId;
}

function getAccount(id) {
  return publicAccount(db.prepare("SELECT id, username, role FROM accounts WHERE id = ?").get(Number(id)));
}

function ensureAdmin(initialPassword) {
  const existing = db.prepare("SELECT username FROM accounts WHERE id = ?").get(ADMIN_ID);
  if (existing) {
    if (existing.username !== ADMIN_USERNAME) {
      const clash = db.prepare("SELECT id FROM accounts WHERE username = ? AND id <> ?").get(ADMIN_USERNAME, ADMIN_ID);
      if (clash) throw new Error(`Admin-Name "${ADMIN_USERNAME}" ist schon an Benutzer ${clash.id} vergeben.`);
      db.prepare("UPDATE accounts SET username = ? WHERE id = ?").run(ADMIN_USERNAME, ADMIN_ID);
    }
    return null;
  }
  const password = initialPassword
    ? validatePassword(initialPassword)
    : crypto.randomBytes(12).toString("base64url");
  db.prepare("INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .run(ADMIN_ID, ADMIN_USERNAME, hashPassword(password), nowIso());
  return password;
}

function listAccounts() {
  return db.prepare(`
    SELECT a.id, a.username, a.role, a.created_at AS createdAt,
           (SELECT COUNT(*) FROM trips t WHERE t.created_by = a.id) AS tripCount
    FROM accounts a ORDER BY a.id = 0 DESC, a.username COLLATE NOCASE
  `).all();
}

function listUsernames() {
  return db.prepare("SELECT username FROM accounts ORDER BY id = 0 DESC, username COLLATE NOCASE")
    .all().map((r) => r.username);
}

function requireEditableAccount(id) {
  const account = getAccount(id);
  if (!account) throw new HttpError(404, "Benutzer nicht gefunden.");
  if (account.id === ADMIN_ID) {
    throw new HttpError(403, "Der Admin ist fest und kann nicht verändert oder gelöscht werden.");
  }
  return account;
}

function createAccount(input) {
  const username = normalizeUsername(input && input.username);
  const password = validatePassword(input && input.password);
  const role = normalizeRole(input && input.role);
  return transaction(() => {
    if (db.prepare("SELECT 1 FROM accounts WHERE username = ?").get(username)) {
      throw new HttpError(409, `Den Benutzernamen "${username}" gibt es schon.`);
    }
    const id = db.prepare("SELECT MAX(COALESCE(MAX(id), 0) + 1, 1) AS n FROM accounts").get().n;
    db.prepare("INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, username, hashPassword(password), role, nowIso());
    return getAccount(id);
  });
}

function updateAccountRole(id, role) {
  const account = requireEditableAccount(id);
  db.prepare("UPDATE accounts SET role = ? WHERE id = ?").run(normalizeRole(role), account.id);
  // Rechte geaendert: offene Sitzungen bekommen die neue Rolle beim naechsten Aufruf.
  return getAccount(account.id);
}

/** Loescht einen Benutzer samt allen seinen Reisen (Stationen und Bilder per CASCADE). */
function deleteAccount(id, actingId) {
  const account = requireEditableAccount(id);
  if (account.id === actingId) throw new HttpError(400, "Man kann sich nicht selbst löschen.");
  return transaction(() => {
    const trips = db.prepare("DELETE FROM trips WHERE created_by = ?").run(account.id).changes;
    db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
    return { deleted: account.username, deletedTrips: trips };
  });
}

function authenticate(username, password) {
  const row = db.prepare("SELECT id, username, role, password_hash AS hash FROM accounts WHERE username = ?")
    .get(String(username || "").trim());
  const ok = verifyPassword(String(password || ""), row ? row.hash : DUMMY_HASH);
  return ok && row ? publicAccount(row) : null;
}

function setAccountPassword(id, adminId, adminPassword, newPassword) {
  const admin = db.prepare("SELECT password_hash AS hash FROM accounts WHERE id = ?").get(adminId);
  if (!admin || !verifyPassword(String(adminPassword || ""), admin.hash)) {
    throw new HttpError(400, "Dein Admin-Passwort stimmt nicht.");
  }
  const account = requireEditableAccount(id);
  db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
    .run(hashPassword(validatePassword(newPassword)), account.id);
  db.prepare("DELETE FROM account_sessions WHERE account_id = ?").run(account.id);
  return getAccount(account.id);
}

function changeOwnPassword(accountId, currentPassword, newPassword, keepTokenHash) {
  const row = db.prepare("SELECT password_hash AS hash FROM accounts WHERE id = ?").get(accountId);
  if (!row || !verifyPassword(String(currentPassword || ""), row.hash)) {
    throw new HttpError(400, "Das bisherige Passwort stimmt nicht.");
  }
  db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
    .run(hashPassword(validatePassword(newPassword)), accountId);
  db.prepare("DELETE FROM account_sessions WHERE account_id = ? AND token_hash <> ?")
    .run(accountId, keepTokenHash || "");
}

/* ------------------------------------------------------------ Sitzungen */

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
}

function createSession(accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM account_sessions WHERE expires_at < ?").run(nowIso());
  db.prepare("INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), accountId, nowIso(), sessionExpiry());
  return token;
}

function getSessionAccount(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.expires_at AS expiresAt, a.id, a.username, a.role
    FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  const remaining = Date.parse(row.expiresAt) - Date.now();
  if (remaining <= 0) {
    db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  if (remaining < SESSION_RENEW_DAYS * 86400000) {
    db.prepare("UPDATE account_sessions SET expires_at = ? WHERE token_hash = ?").run(sessionExpiry(), tokenHash);
  }
  return { ...publicAccount(row), tokenHash };
}

function deleteSession(token) {
  if (token) db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(hashToken(token));
}

module.exports = {
  HttpError,
  SCHEMA_VERSION,
  APP_ID,
  CATEGORY_OPTIONS,
  MAX_IMAGE_BYTES,
  open,
  close,
  makeId,
  listTripsPage,
  listTripFilters,
  getTrip,
  createTrip,
  updateTrip,
  deleteTrip,
  getImage,
  listCategoryOptions,
  getStats,
  ADMIN_ID,
  ADMIN_USERNAME,
  SESSION_DAYS,
  canWrite,
  tripOwnerFilter,
  canAccessTrip,
  getAccount,
  listAccounts,
  listUsernames,
  createAccount,
  updateAccountRole,
  deleteAccount,
  authenticate,
  changeOwnPassword,
  setAccountPassword,
  createSession,
  getSessionAccount,
  deleteSession,
};
