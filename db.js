"use strict";

/* =========================================================================
   Datenschicht - SQLite ueber das eingebaute Modul node:sqlite.
   Keine externen Abhaengigkeiten, keine native Kompilierung.

   Das Schema ist relational normalisiert: Zutaten und Bilder haengen per
   Fremdschluessel am Rezept und werden beim Loeschen mit entfernt (CASCADE).
   Bilder liegen als BLOB in der Datenbank und werden ueber eine eigene
   URL ausgeliefert - nicht mehr als Base64 im Datensatz.
   ========================================================================= */

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

// 2: Benutzer (accounts) mit Rollen, Sitzungen, recipes.created_by
const SCHEMA_VERSION = 2;

// Feste Auswahl fuer das Feld Kategorie (genau eine je Rezept, oder keine = "").
// Die Liste liegt bewusst nur hier; der Client bekommt sie ueber /api/state.
const CATEGORY_OPTIONS = [
  "Suppe", "Vorspeise & Salat", "Fleisch", "Fisch", "Pasta & Italienisch",
  "Asiatisch", "Vegetarisch & Vegan", "Beilage", "Brot & Backwaren",
  "Dessert & Kuchen", "Frühstück", "Getränk",
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
CREATE TABLE IF NOT EXISTS recipes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_desc  TEXT NOT NULL DEFAULT '',
  long_text   TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredients (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  amount    TEXT NOT NULL DEFAULT '',
  position  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id, position);

CREATE TABLE IF NOT EXISTS images (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL DEFAULT '',
  mime      TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  data      BLOB NOT NULL,
  position  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_recipe ON images(recipe_id, position);

CREATE TABLE IF NOT EXISTS fridge_items (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  amount     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- COLLATE NOCASE: "Mehl" und "mehl" sind derselbe Katalogeintrag.
CREATE TABLE IF NOT EXISTS ingredient_catalog (
  name TEXT PRIMARY KEY COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Benutzer. Rolle: 'admin' (genau einer, fest id 0), 'rw' (lesen + schreiben),
-- 'r' (nur lesen). Der CHECK erzwingt: id 0 <=> admin.
-- (Eigener Tabellenname: eine alte, nicht mehr genutzte Tabelle "users"
-- kann in bestehenden Datenbanken noch liegen.)
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
  db.exec(SCHEMA_SQL);

  // Bestehende Datenbanken aus der Zeit vor der Kategorie: Spalte nachziehen.
  // (CREATE TABLE IF NOT EXISTS ergaenzt keine Spalten an vorhandenen Tabellen.)
  const recipeColumns = db.prepare("PRAGMA table_info(recipes)").all().map((c) => c.name);
  if (!recipeColumns.includes("category")) {
    db.exec("ALTER TABLE recipes ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  }
  // Den festen Admin zuerst - der Rezeptbestand unten verweist auf ihn.
  const generatedAdminPassword = ensureAdmin(options.adminPassword);

  // Schema 2: wer ein Rezept angelegt hat (nur zur Anzeige). Der Bestand
  // von vorher bekommt den Admin.
  if (!recipeColumns.includes("created_by")) {
    db.exec("ALTER TABLE recipes ADD COLUMN created_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
    db.exec("UPDATE recipes SET created_by = 0");
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) > SCHEMA_VERSION) {
    throw new Error(
      `Datenbank hat Schema-Version ${row.value}, dieser Server kennt nur ${SCHEMA_VERSION}.`
    );
  } else if (Number(row.value) < SCHEMA_VERSION) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }
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

/** Zerlegt "data:image/png;base64,..." in MIME-Typ und Binaerdaten. */
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new HttpError(400, "Neues Bild ohne Daten - Feld \"dataUrl\" fehlt.");
  }
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) {
    throw new HttpError(415, "Nur Bilder als Base64-Data-URL (data:image/...;base64,...) werden akzeptiert.");
  }
  const buf = Buffer.from(match[2], "base64");
  if (buf.length === 0) throw new HttpError(400, "Bilddaten sind leer.");
  if (buf.length > MAX_IMAGE_BYTES) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new HttpError(413, `Bild ist zu gross (${mb(buf.length)} MB), erlaubt sind ${mb(MAX_IMAGE_BYTES)} MB.`);
  }
  return { mime: match[1], buf };
}

/* ------------------------------------------------------------- Rezepte */

const RECIPE_SORT_COLUMNS = {
  name: "r.name COLLATE NOCASE",
  shortDesc: "r.short_desc COLLATE NOCASE",
  updatedAt: "r.updated_at",
  createdBy: "a.username COLLATE NOCASE",
};
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Escaped % und _ (LIKE-Platzhalter) sowie das Escape-Zeichen selbst. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * WHERE-Klausel der Rezeptsuche (Name, Kurzbeschreibung, Zutatennamen) -
 * gemeinsam genutzt von der Uebersicht und den Empfehlungen, damit beide
 * exakt denselben Filter meinen. Tabellenalias im Aufrufer: r.
 */
function buildSearchWhere(term) {
  if (!term) return { where: "", params: [] };
  const like = `%${escapeLike(term)}%`;
  return {
    where: `WHERE (r.name LIKE ? ESCAPE '\\'
       OR r.short_desc LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM ingredients si WHERE si.recipe_id = r.id AND si.name LIKE ? ESCAPE '\\'))`,
    params: [like, like, like],
  };
}

/**
 * Rezeptuebersicht mit Suche, Sortierung und Seitenteilung - alles direkt
 * in SQL, damit auch bei vielen hundert Rezepten nur eine Seite an Daten
 * ueber die Leitung geht. Die Suche prueft Name, Kurzbeschreibung und
 * Zutatennamen. Bewusst ohne Langtext und ohne Bilddaten.
 */
function listRecipesPage(options = {}) {
  const sortBy = RECIPE_SORT_COLUMNS[options.sortBy] ? options.sortBy : "name";
  const sortDir = options.sortDir === "desc" ? "DESC" : "ASC";
  const term = text(options.search, "search", { max: 100 }).trim();
  const page = Math.max(1, Math.trunc(Number(options.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(options.pageSize)) || DEFAULT_PAGE_SIZE));

  const { where, params } = buildSearchWhere(term);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM recipes r ${where}`).get(...params).n;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Liegt die angeforderte Seite ausserhalb (z.B. nach dem Loeschen des
  // letzten Eintrags einer Seite), auf die letzte gueltige Seite zurueckfallen.
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const items = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.updated_at AS updatedAt,
           a.username AS createdByName,
           (SELECT COUNT(*) FROM ingredients i WHERE i.recipe_id = r.id) AS ingredientCount,
           (SELECT COUNT(*) FROM images g      WHERE g.recipe_id = r.id) AS imageCount,
           (SELECT id FROM images g WHERE g.recipe_id = r.id ORDER BY position LIMIT 1) AS firstImageId
    FROM recipes r
    LEFT JOIN accounts a ON a.id = r.created_by
    ${where}
    ORDER BY ${RECIPE_SORT_COLUMNS[sortBy]} ${sortDir}, r.id ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  // Miniatur-URL fuer die Uebersicht: das erste Bild (nach position) des
  // Rezepts, falls vorhanden. Die Bytes selbst kommen wie ueberall ueber
  // GET /api/images/:id - hier wird nur die id in eine URL uebersetzt.
  for (const item of items) {
    item.thumbnailUrl = item.firstImageId ? `/api/images/${item.firstImageId}` : null;
    delete item.firstImageId;
  }

  return { items, total, page: safePage, pageSize, totalPages };
}

function getRecipe(id) {
  const recipe = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.long_text AS longText, r.category,
           r.created_at AS createdAt, r.updated_at AS updatedAt,
           r.created_by AS createdBy, a.username AS createdByName
    FROM recipes r LEFT JOIN accounts a ON a.id = r.created_by
    WHERE r.id = ?
  `).get(id);
  if (!recipe) return null;

  recipe.ingredients = db.prepare(`
    SELECT id, name, amount FROM ingredients WHERE recipe_id = ? ORDER BY position
  `).all(id);

  // Bewusst ohne Spalte "data" - die Bytes kommen ueber GET /api/images/:id.
  recipe.images = db.prepare(`
    SELECT id, name, mime, bytes FROM images WHERE recipe_id = ? ORDER BY position
  `).all(id).map((img) => ({ ...img, url: `/api/images/${img.id}` }));

  return recipe;
}

function writeIngredients(recipeId, ingredients) {
  // Zutaten sind reine Textzeilen ohne eigenen Wert - komplett neu schreiben
  // ist hier einfacher und korrekter als ein Abgleich Zeile fuer Zeile.
  db.prepare("DELETE FROM ingredients WHERE recipe_id = ?").run(recipeId);
  const insert = db.prepare(
    "INSERT INTO ingredients (id, recipe_id, name, amount, position) VALUES (?, ?, ?, ?, ?)"
  );
  ingredients.forEach((ing, index) => {
    const name = text(ing && ing.name, "ingredients[].name", { max: 60 });
    if (!name.trim()) return; // leere Zeilen still verwerfen
    insert.run(makeId(), recipeId, name.trim(), text(ing.amount, "ingredients[].amount", { max: 30 }).trim(), index);
  });
}

function writeImages(recipeId, images) {
  // Bilder duerfen NICHT pauschal neu geschrieben werden: der Client schickt
  // fuer bestehende Bilder nur die id, die Bytes liegen allein hier.
  const existing = new Set(
    db.prepare("SELECT id FROM images WHERE recipe_id = ?").all(recipeId).map((r) => r.id)
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
    "INSERT INTO images (id, recipe_id, name, mime, bytes, data, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  images.forEach((img, index) => {
    const name = text(img && img.name, "images[].name", { max: 200 });
    if (img && img.id && kept.has(img.id)) {
      reposition.run(index, name, img.id);
    } else {
      const { mime, buf } = decodeDataUrl(img && img.dataUrl);
      insert.run(makeId(), recipeId, name, mime, buf.length, buf, index);
    }
  });
}

/** Uebernimmt die Zutatennamen eines Rezepts in den Vorschlagskatalog. */
function syncCatalogFromIngredients(ingredients) {
  for (const ing of ingredients) {
    const name = ing && ing.name != null ? String(ing.name).trim() : "";
    if (name) addCatalogEntry(name);
  }
}

function normalizeRecipeInput(input) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Rezept-Daten fehlen oder sind kein Objekt.");
  }
  const ingredients = input.ingredients == null ? [] : input.ingredients;
  const images = input.images == null ? [] : input.images;
  if (!Array.isArray(ingredients)) throw new HttpError(400, 'Feld "ingredients" muss eine Liste sein.');
  if (!Array.isArray(images)) throw new HttpError(400, 'Feld "images" muss eine Liste sein.');
  return {
    name: text(input.name, "name", { max: 80, required: true }),
    shortDesc: text(input.shortDesc, "shortDesc", { max: 150 }).trim(),
    longText: text(input.longText, "longText", { max: 20000 }),
    category: normalizeCategory(input.category),
    ingredients,
    images,
  };
}

/** Kategorie: leer (keine) oder genau ein Wert aus CATEGORY_OPTIONS. */
function normalizeCategory(value) {
  const category = value == null ? "" : String(value).trim();
  if (category && !CATEGORY_OPTIONS.includes(category)) {
    throw new HttpError(400, `Unbekannte Kategorie "${category}".`);
  }
  return category;
}

function insertRecipe(id, data, accountId) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO recipes (id, name, short_desc, long_text, category, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, data.shortDesc, data.longText, data.category, accountId, ts, ts);
}

function createRecipe(input, accountId) {
  const data = normalizeRecipeInput(input);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeId();
  return transaction(() => {
    if (db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
      throw new HttpError(409, `Es existiert bereits ein Rezept mit der id "${id}".`);
    }
    insertRecipe(id, data, accountId);
    writeIngredients(id, data.ingredients);
    writeImages(id, data.images);
    syncCatalogFromIngredients(data.ingredients);
    return getRecipe(id);
  });
}

function updateRecipe(id, input) {
  const data = normalizeRecipeInput(input);
  return transaction(() => {
    if (!db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
      throw new HttpError(404, `Rezept "${id}" nicht gefunden.`);
    }
    db.prepare(`
      UPDATE recipes SET name = ?, short_desc = ?, long_text = ?, category = ?, updated_at = ? WHERE id = ?
    `).run(data.name, data.shortDesc, data.longText, data.category, nowIso(), id);
    writeIngredients(id, data.ingredients);
    writeImages(id, data.images);
    syncCatalogFromIngredients(data.ingredients);
    return getRecipe(id);
  });
}

function deleteRecipe(id) {
  // Zutaten und Bilder verschwinden per ON DELETE CASCADE mit.
  return db.prepare("DELETE FROM recipes WHERE id = ?").run(id).changes > 0;
}

/* -------------------------------------------------------------- Bilder */

function getImage(id) {
  return db.prepare("SELECT id, name, mime, bytes, data FROM images WHERE id = ?").get(id) || null;
}

/* -------------------------------------------------------- Kuehlschrank */

function listFridge() {
  return db.prepare(`
    SELECT id, name, amount, created_at AS createdAt FROM fridge_items ORDER BY created_at, rowid
  `).all();
}

function getFridgeItem(id) {
  return db.prepare(`
    SELECT id, name, amount, created_at AS createdAt FROM fridge_items WHERE id = ?
  `).get(id) || null;
}

function addFridgeItem(input) {
  const name = text(input && input.name, "name", { max: 60, required: true });
  const amount = text(input && input.amount, "amount", { max: 20 }).trim();
  const id = input && typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeId();
  db.prepare("INSERT INTO fridge_items (id, name, amount, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, amount, nowIso());
  return getFridgeItem(id);
}

function updateFridgeItem(id, changes) {
  if (!changes || typeof changes !== "object") {
    throw new HttpError(400, "Keine Aenderungen uebergeben.");
  }
  const current = getFridgeItem(id);
  if (!current) throw new HttpError(404, `Kuehlschrank-Eintrag "${id}" nicht gefunden.`);

  // PATCH-Semantik: nur mitgeschickte Felder aendern.
  const name = "name" in changes ? text(changes.name, "name", { max: 60, required: true }) : current.name;
  const amount = "amount" in changes ? text(changes.amount, "amount", { max: 20 }).trim() : current.amount;
  db.prepare("UPDATE fridge_items SET name = ?, amount = ? WHERE id = ?").run(name, amount, id);
  return getFridgeItem(id);
}

function deleteFridgeItem(id) {
  return db.prepare("DELETE FROM fridge_items WHERE id = ?").run(id).changes > 0;
}

function clearFridge() {
  return db.prepare("DELETE FROM fridge_items").run().changes;
}

/* ------------------------------------------------------ Zutaten-Katalog */

function listCatalog() {
  return db.prepare("SELECT name FROM ingredient_catalog ORDER BY name COLLATE NOCASE").all().map((r) => r.name);
}

function addCatalogEntry(name) {
  const clean = text(name, "name", { max: 60, required: true });
  // COLLATE NOCASE auf dem Primaerschluessel faengt Gross-/Kleinschreibung ab.
  db.prepare("INSERT OR IGNORE INTO ingredient_catalog (name) VALUES (?)").run(clean);
  return clean;
}

function deleteCatalogEntry(name) {
  return db.prepare("DELETE FROM ingredient_catalog WHERE name = ?").run(String(name)).changes > 0;
}

/* -------------------------------------------------------------- Import */

/**
 * Uebernimmt einen kompletten Datenbestand im alten localStorage-Format.
 * Bestehende Datensaetze (gleiche id) werden uebersprungen, nicht ueberschrieben.
 */
function importState(state, accountId) {
  if (!state || typeof state !== "object") throw new HttpError(400, "Import-Daten fehlen.");
  const recipes = Array.isArray(state.recipes) ? state.recipes : [];
  const fridge = Array.isArray(state.fridge) ? state.fridge : [];
  const catalog = Array.isArray(state.ingredientCatalog) ? state.ingredientCatalog : [];

  return transaction(() => {
    const result = { recipes: 0, fridge: 0, catalog: 0, skipped: 0 };

    for (const recipe of recipes) {
      if (!recipe || typeof recipe !== "object") continue;
      const id = typeof recipe.id === "string" && recipe.id.trim() ? recipe.id.trim() : makeId();
      if (db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) { result.skipped++; continue; }
      const data = normalizeRecipeInput(recipe);
      insertRecipe(id, data, accountId);
      writeIngredients(id, data.ingredients);
      // Altbestand kennt nur dataUrl-Bilder; ids aus dem Browser gelten hier nicht.
      writeImages(id, data.images.map((img) => ({ name: img && img.name, dataUrl: img && img.dataUrl })));
      syncCatalogFromIngredients(data.ingredients);
      result.recipes++;
    }

    for (const item of fridge) {
      if (!item || typeof item !== "object" || !String(item.name || "").trim()) continue;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : makeId();
      if (db.prepare("SELECT 1 FROM fridge_items WHERE id = ?").get(id)) { result.skipped++; continue; }
      addFridgeItem({ id, name: item.name, amount: item.amount });
      result.fridge++;
    }

    for (const name of catalog) {
      if (typeof name !== "string" || !name.trim()) continue;
      addCatalogEntry(name);
      result.catalog++;
    }

    return result;
  });
}

/* --------------------------------------------------------------- Stand */

function getState() {
  // Die Rezeptliste kommt bewusst nicht hierher - sie wird paginiert ueber
  // listRecipesPage()/GET /api/recipes geladen, damit /api/state bei vielen
  // Rezepten klein und schnell bleibt.
  return { fridge: listFridge(), ingredientCatalog: listCatalog(), categoryOptions: CATEGORY_OPTIONS };
}

function getStats() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    recipes: one("SELECT COUNT(*) AS n FROM recipes"),
    ingredients: one("SELECT COUNT(*) AS n FROM ingredients"),
    images: one("SELECT COUNT(*) AS n FROM images"),
    imageBytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM images").get().n,
    fridgeItems: one("SELECT COUNT(*) AS n FROM fridge_items"),
    catalogEntries: one("SELECT COUNT(*) AS n FROM ingredient_catalog"),
    accounts: one("SELECT COUNT(*) AS n FROM accounts"),
  };
}

/* ------------------------------------------------------------ Benutzer */

// Rollen: "admin" (genau einer, fest id 0, unveraenderlich), "rw" (lesen und
// schreiben, inkl. Benutzerverwaltung), "r" (nur lesen).
const ADMIN_ID = 0;
const ADMIN_USERNAME = "admin";
const SESSION_DAYS = 30;
// Restlaufzeit, unter der eine aktiv genutzte Sitzung wieder auf volle Dauer verlaengert wird.
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

/** Schreiben duerfen Admin und "rw" - Rezepte, Kuehlschrank, Katalog und Benutzerverwaltung. */
function canWrite(account) {
  return !!account && (account.role === "admin" || account.role === "rw");
}

function getAccount(id) {
  return publicAccount(db.prepare("SELECT id, username, role FROM accounts WHERE id = ?").get(Number(id)));
}

/**
 * Legt den festen Admin (id 0) an, falls er fehlt. Startpasswort: das
 * uebergebene, sonst zufaellig. Liefert es nur beim Anlegen zurueck.
 */
function ensureAdmin(initialPassword) {
  if (db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(ADMIN_ID)) return null;
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
           (SELECT COUNT(*) FROM recipes r WHERE r.created_by = a.id) AS recipeCount
    FROM accounts a ORDER BY a.id = 0 DESC, a.username COLLATE NOCASE
  `).all();
}

/** Der Admin ist fest: er laesst sich ueber die Verwaltung weder aendern noch loeschen. */
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
    // id 0 gehoert dem Admin, alle anderen zaehlen ab 1 hoch.
    const id = db.prepare("SELECT MAX(COALESCE(MAX(id), 0) + 1, 1) AS n FROM accounts").get().n;
    db.prepare("INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, username, hashPassword(password), role, nowIso());
    return getAccount(id);
  });
}

/** Aendert einen Benutzer: { username?, role?, password? }. */
function updateAccount(id, changes, actingId) {
  if (!changes || typeof changes !== "object") throw new HttpError(400, "Keine Aenderungen uebergeben.");
  return transaction(() => {
    const account = requireEditableAccount(id);
    if ("username" in changes) {
      const username = normalizeUsername(changes.username);
      const clash = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
      if (clash && clash.id !== account.id) {
        throw new HttpError(409, `Den Benutzernamen "${username}" gibt es schon.`);
      }
      db.prepare("UPDATE accounts SET username = ? WHERE id = ?").run(username, account.id);
    }
    if ("role" in changes) {
      const role = normalizeRole(changes.role);
      if (account.id === actingId && role !== account.role) {
        throw new HttpError(400, "Die eigenen Rechte kann man nicht selbst ändern.");
      }
      db.prepare("UPDATE accounts SET role = ? WHERE id = ?").run(role, account.id);
    }
    if ("password" in changes) {
      db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
        .run(hashPassword(validatePassword(changes.password)), account.id);
      // Neues Passwort: alle bestehenden Anmeldungen dieses Benutzers beenden.
      db.prepare("DELETE FROM account_sessions WHERE account_id = ?").run(account.id);
    }
    return getAccount(account.id);
  });
}

/** Loescht einen Benutzer. Seine Rezepte bleiben, nur "erstellt von" wird leer. */
function deleteAccount(id, actingId) {
  const account = requireEditableAccount(id);
  if (account.id === actingId) throw new HttpError(400, "Man kann sich nicht selbst löschen.");
  db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
  return { deleted: account.username };
}

/** Prueft Benutzername + Passwort; liefert den Benutzer oder null. */
function authenticate(username, password) {
  const row = db.prepare("SELECT id, username, role, password_hash AS hash FROM accounts WHERE username = ?")
    .get(String(username || "").trim());
  const ok = verifyPassword(String(password || ""), row ? row.hash : DUMMY_HASH);
  return ok && row ? publicAccount(row) : null;
}

/** Eigenes Passwort aendern - das darf jeder, auch der Admin. */
function changeOwnPassword(accountId, currentPassword, newPassword, keepTokenHash) {
  const row = db.prepare("SELECT password_hash AS hash FROM accounts WHERE id = ?").get(accountId);
  if (!row || !verifyPassword(String(currentPassword || ""), row.hash)) {
    throw new HttpError(400, "Das bisherige Passwort stimmt nicht.");
  }
  db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
    .run(hashPassword(validatePassword(newPassword)), accountId);
  // Andere Geraete abmelden, die aktuelle Sitzung bleibt.
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

/** Legt eine Sitzung an und liefert das Token (nur hier im Klartext). */
function createSession(accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM account_sessions WHERE expires_at < ?").run(nowIso());
  db.prepare("INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), accountId, nowIso(), sessionExpiry());
  return token;
}

/** Benutzer zur Sitzung oder null; verlaengert aktiv genutzte Sitzungen. */
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

/* ---------------------------------------------------------- Empfehlungen */

const DEFAULT_RECOMMENDATION_LIMIT = 4;
const MAX_RECOMMENDATION_LIMIT = 10;

// Zutaten, die man praktisch immer im Haus hat: zaehlen als "vorhanden",
// aber nur mit halbem Gewicht - sie sollen ein Rezept nicht allein nach
// vorne bringen.
const PANTRY_STAPLES = new Set(["salz", "pfeffer", "wasser", "oel", "olivenoel", "zucker"]);

// Fuellwoerter in Zutatennamen, die fuer den Abgleich nichts aussagen.
const NAME_STOPWORDS = new Set([
  "und", "oder", "mit", "frisch", "frische", "frischer", "gehackt", "gehackte",
  "gekocht", "gekochte", "gemischt", "gemischte", "gross", "grosse", "klein", "kleine",
]);

/** Kleinbuchstaben, Umlaute aufgeloest, nur a-z/0-9 - fuer robusten Namensvergleich. */
function foldWord(word) {
  return word
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Einfache Endungskuerzung, damit Zwiebel/Zwiebeln, Tomate/Tomaten, Kartoffel/Kartoffeln zusammenfallen. */
function stemWord(word) {
  if (word === "ei") return "eier";
  const stripped = word.replace(/(ern|en|er|e|n|s)$/, "");
  return stripped.length >= 4 ? stripped : word;
}

/**
 * Kernwort eines Zutatennamens: bei "Rote Zwiebeln, gehackt" das letzte
 * inhaltstragende Wort ("zwiebeln"). Im Deutschen steht der Kern hinten
 * ("Rote Zwiebel" ist eine Zwiebel), dadurch trifft ein Kuehlschrank-
 * eintrag "Rote Bete" nicht faelschlich jede andere "rote" Zutat.
 */
function coreWord(name) {
  const words = String(name)
    .split(/[^A-Za-zÄÖÜäöüß0-9]+/)
    .map(foldWord)
    .filter((w) => w && !NAME_STOPWORDS.has(w));
  if (words.length === 0) return null;
  const raw = words[words.length - 1];
  return { raw, stem: stemWord(raw) };
}

/** Zwei Kernwoerter passen: gleich, Wortanfang oder Wortende (Komposita: "Butter" ~ "Butterschmalz", "Speck" ~ "Kochspeck"). */
function coreMatch(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a);
}

/** Gewichtete Zufallsauswahl ohne Zuruecklegen: [{item, weight}] -> bis zu n Items. */
function weightedSample(entries, n) {
  const pool = entries.map((e) => ({ ...e }));
  const picked = [];
  while (picked.length < n && pool.length > 0) {
    const total = pool.reduce((sum, e) => sum + e.weight, 0);
    let r = Math.random() * total;
    let idx = pool.findIndex((e) => (r -= e.weight) < 0);
    if (idx === -1) idx = pool.length - 1;
    picked.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return picked;
}

/**
 * Empfiehlt Rezepte anhand von Kuehlschrank-Bestand und aktuellem Suchfilter.
 *
 * Ablauf:
 *  1. Kandidaten = Rezepte, die den Suchfilter der Tabelle erfuellen.
 *  2. Jede Zutat wird ueber ihr Kernwort (siehe coreWord) gegen die
 *     Kuehlschrank-Eintraege abgeglichen. Vorraete wie Salz/Pfeffer/Wasser
 *     gelten als vorhanden (halbes Gewicht).
 *  3. Kuehlschrank-Eintraege haben ein Dringlichkeitsgewicht: was schon
 *     laenger drin liegt (createdAt), soll zuerst verbraucht werden
 *     (Faktor 1.0 bis 1.5 ueber 14 Tage).
 *  4. Score = 0.55 * Abdeckung (Anteil der Zutaten, die da sind)
 *           + 0.45 * Verwertung (wie viel Dringlichkeit das Rezept aufbraucht)
 *           - 0.03 pro fehlender Zutat.
 *  5. Aus den Kandidaten mit mindestens einem Kuehlschrank-Treffer wird
 *     GEWICHTET ZUFAELLIG gezogen (Gewicht = Score^2): gute Rezepte sind
 *     wahrscheinlicher, aber nicht immer dieselben. Zuletzt gezeigte
 *     Rezepte (exclude) bekommen nur 5 % Gewicht, damit ein erneuter Klick
 *     wirklich eine neue Liste liefert, solange genug Alternativen da sind.
 *  6. Reichen die Treffer nicht fuer limit, wird aus den uebrigen
 *     Kandidaten des Filters zufaellig aufgefuellt (reason "filler").
 */
function getRecommendations(options = {}) {
  const limit = Math.min(
    MAX_RECOMMENDATION_LIMIT,
    Math.max(1, Math.trunc(Number(options.limit)) || DEFAULT_RECOMMENDATION_LIMIT)
  );
  const term = text(options.search, "search", { max: 100 }).trim();
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude.map(String) : []);

  // Kuehlschrank -> Kernwoerter mit Dringlichkeit
  const now = Date.now();
  const fridge = listFridge()
    .map((f) => {
      const core = coreWord(f.name);
      const ageDays = Math.max(0, (now - Date.parse(f.createdAt)) / 86400000) || 0;
      return core ? { name: f.name, core, urgency: 1 + 0.5 * Math.min(ageDays, 14) / 14 } : null;
    })
    .filter(Boolean);

  // Kandidaten laut Suchfilter samt Zutaten
  const { where, params } = buildSearchWhere(term);
  const rows = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, ing.name AS ingredientName
    FROM recipes r
    LEFT JOIN ingredients ing ON ing.recipe_id = r.id
    ${where}
    ORDER BY r.id, ing.position
  `).all(...params);

  const byRecipe = new Map();
  for (const row of rows) {
    let entry = byRecipe.get(row.id);
    if (!entry) {
      entry = { id: row.id, name: row.name, shortDesc: row.shortDesc, ingredients: [] };
      byRecipe.set(row.id, entry);
    }
    if (row.ingredientName) entry.ingredients.push(row.ingredientName);
  }

  const scored = [...byRecipe.values()].map((r) => {
    const matched = [];
    const missing = [];
    let pantryHits = 0;
    let urgencySum = 0;
    for (const ingredient of r.ingredients) {
      const core = coreWord(ingredient);
      if (!core) continue;
      const hit = fridge.filter((f) => coreMatch(core.stem, f.core.stem));
      if (hit.length > 0) {
        matched.push(ingredient);
        urgencySum += Math.max(...hit.map((f) => f.urgency));
      } else if (PANTRY_STAPLES.has(core.raw)) {
        pantryHits++;
      } else {
        missing.push(ingredient);
      }
    }
    const total = matched.length + pantryHits + missing.length;
    const coverage = total ? (matched.length + 0.5 * pantryHits) / total : 0;
    const usage = Math.min(1, urgencySum / 4);
    const score = matched.length > 0
      ? Math.max(0.01, 0.55 * coverage + 0.45 * usage - 0.03 * missing.length)
      : 0;
    return {
      id: r.id, name: r.name, shortDesc: r.shortDesc,
      matched, missing, totalIngredients: total, score,
    };
  });

  const weightOf = (r) => (r.score * r.score + 0.0001) * (exclude.has(r.id) ? 0.05 : 1);
  const withHits = scored.filter((r) => r.score > 0);
  let picked = weightedSample(withHits.map((r) => ({ item: r, weight: weightOf(r) })), limit)
    .map((r) => ({ ...r, reason: "fridge" }));

  if (picked.length < limit) {
    const usedIds = new Set(picked.map((r) => r.id));
    const rest = scored.filter((r) => !usedIds.has(r.id));
    // Frisch Vorgeschlagenes zuletzt auffuellen, sonst gleichverteilt zufaellig.
    const filler = weightedSample(
      rest.map((r) => ({ item: r, weight: exclude.has(r.id) ? 0.05 : 1 })),
      limit - picked.length
    ).map((r) => ({ ...r, reason: "filler" }));
    picked = [...picked, ...filler];
  }

  // Beste zuerst anzeigen
  picked.sort((a, b) => b.score - a.score);

  if (picked.length === 0) {
    return { items: [], basedOnFridge: false, fridgeItems: fridge.length, candidates: 0, search: term };
  }

  const placeholders = picked.map(() => "?").join(",");
  const imageRows = db.prepare(`
    SELECT recipe_id AS recipeId, id FROM (
      SELECT recipe_id, id,
             ROW_NUMBER() OVER (PARTITION BY recipe_id ORDER BY position) AS rn
      FROM images
      WHERE recipe_id IN (${placeholders})
    )
    WHERE rn = 1
  `).all(...picked.map((r) => r.id));
  const thumbByRecipe = new Map(imageRows.map((row) => [row.recipeId, row.id]));

  return {
    items: picked.map((r) => ({
      id: r.id,
      name: r.name,
      shortDesc: r.shortDesc,
      reason: r.reason,
      matchCount: r.matched.length,
      totalIngredients: r.totalIngredients,
      matched: r.matched,
      missing: r.missing,
      thumbnailUrl: thumbByRecipe.has(r.id) ? `/api/images/${thumbByRecipe.get(r.id)}` : null,
    })),
    basedOnFridge: picked.some((r) => r.reason === "fridge"),
    fridgeItems: fridge.length,
    candidates: scored.length,
    search: term,
  };
}

module.exports = {
  HttpError,
  SCHEMA_VERSION,
  CATEGORY_OPTIONS,
  MAX_IMAGE_BYTES,
  open,
  close,
  makeId,
  listRecipesPage,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  getImage,
  listFridge,
  addFridgeItem,
  updateFridgeItem,
  deleteFridgeItem,
  clearFridge,
  listCatalog,
  addCatalogEntry,
  deleteCatalogEntry,
  importState,
  getState,
  getStats,
  getRecommendations,
  ADMIN_ID,
  SESSION_DAYS,
  canWrite,
  getAccount,
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  authenticate,
  changeOwnPassword,
  createSession,
  getSessionAccount,
  deleteSession,
};
