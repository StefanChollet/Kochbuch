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

// 2: Benutzer, Sitzungen, Rezept-Besitzer und Freigaben
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

-- COLLATE NOCASE: "Anna" und "anna" sind derselbe Benutzer.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- Gespeichert wird nur der SHA-256 des Tokens, nie das Token selbst.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Freigabe eines Rezepts an einen anderen Benutzer: nur lesen oder auch schreiben.
CREATE TABLE IF NOT EXISTS recipe_shares (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recipe_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON recipe_shares(user_id);
`;

function open(file) {
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
  // Schema 2: jedes Rezept gehoert einem Benutzer. Bestand ohne Besitzer
  // bekommt der erste Administrator (siehe setupFirstAdmin/adoptOrphanRecipes).
  if (!recipeColumns.includes("owner_id")) {
    db.exec("ALTER TABLE recipes ADD COLUMN owner_id TEXT REFERENCES users(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_recipes_owner ON recipes(owner_id)");

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

  adoptOrphanRecipes();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  return db;
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
  owner: "u.username COLLATE NOCASE",
};
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Escaped % und _ (LIKE-Platzhalter) sowie das Escape-Zeichen selbst. */
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * WHERE-Klausel fuer Rezeptlisten - gemeinsam genutzt von der Uebersicht
 * und den Empfehlungen, damit beide exakt dieselbe Auswahl meinen.
 * Sichtbar sind eigene Rezepte und solche, die fuer userId freigegeben sind.
 * scope: "all" | "mine" | "shared". Die Suche prueft Name, Kurzbeschreibung
 * und Zutatennamen. Tabellenalias im Aufrufer: r.
 */
function buildRecipeWhere(userId, { search = "", scope = "all" } = {}) {
  const shared = "EXISTS (SELECT 1 FROM recipe_shares vs WHERE vs.recipe_id = r.id AND vs.user_id = ?)";
  const conditions = [];
  const params = [];
  if (scope === "mine") {
    conditions.push("r.owner_id = ?");
    params.push(userId);
  } else if (scope === "shared") {
    conditions.push(shared);
    params.push(userId);
  } else {
    conditions.push(`(r.owner_id = ? OR ${shared})`);
    params.push(userId, userId);
  }
  if (search) {
    const like = `%${escapeLike(search)}%`;
    conditions.push(`(r.name LIKE ? ESCAPE '\\'
       OR r.short_desc LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM ingredients si WHERE si.recipe_id = r.id AND si.name LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like);
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

// Zugriffsrecht des Benutzers (Parameter 1) auf das Rezept r als SQL-Ausdruck.
const ACCESS_SQL = `CASE WHEN r.owner_id = ? THEN 'owner'
  WHEN (SELECT can_write FROM recipe_shares a WHERE a.recipe_id = r.id AND a.user_id = ?) = 1 THEN 'write'
  ELSE 'read' END`;

/**
 * Rezeptuebersicht mit Suche, Sortierung und Seitenteilung - alles direkt
 * in SQL, damit auch bei vielen hundert Rezepten nur eine Seite an Daten
 * ueber die Leitung geht. Bewusst ohne Langtext und ohne Bilddaten.
 */
function listRecipesPage(userId, options = {}) {
  const sortBy = RECIPE_SORT_COLUMNS[options.sortBy] ? options.sortBy : "name";
  const sortDir = options.sortDir === "desc" ? "DESC" : "ASC";
  const term = text(options.search, "search", { max: 100 }).trim();
  const scope = ["mine", "shared"].includes(options.scope) ? options.scope : "all";
  const page = Math.max(1, Math.trunc(Number(options.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(options.pageSize)) || DEFAULT_PAGE_SIZE));

  const { where, params } = buildRecipeWhere(userId, { search: term, scope });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM recipes r ${where}`).get(...params).n;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Liegt die angeforderte Seite ausserhalb (z.B. nach dem Loeschen des
  // letzten Eintrags einer Seite), auf die letzte gueltige Seite zurueckfallen.
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const items = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.updated_at AS updatedAt,
           u.username AS ownerName,
           ${ACCESS_SQL} AS access,
           (SELECT COUNT(*) FROM recipe_shares x WHERE x.recipe_id = r.id) AS shareCount,
           (SELECT COUNT(*) FROM ingredients i WHERE i.recipe_id = r.id) AS ingredientCount,
           (SELECT COUNT(*) FROM images g      WHERE g.recipe_id = r.id) AS imageCount,
           (SELECT id FROM images g WHERE g.recipe_id = r.id ORDER BY position LIMIT 1) AS firstImageId
    FROM recipes r
    LEFT JOIN users u ON u.id = r.owner_id
    ${where}
    ORDER BY ${RECIPE_SORT_COLUMNS[sortBy]} ${sortDir}, r.id ${sortDir}
    LIMIT ? OFFSET ?
  `).all(userId, userId, ...params, pageSize, offset);

  // Miniatur-URL fuer die Uebersicht: das erste Bild (nach position) des
  // Rezepts, falls vorhanden. Die Bytes selbst kommen wie ueberall ueber
  // GET /api/images/:id - hier wird nur die id in eine URL uebersetzt.
  for (const item of items) {
    item.thumbnailUrl = item.firstImageId ? `/api/images/${item.firstImageId}` : null;
    delete item.firstImageId;
    // Wem ein fremdes Rezept sonst noch freigegeben ist, geht nur den Besitzer etwas an.
    if (item.access !== "owner") delete item.shareCount;
  }

  return { items, total, page: safePage, pageSize, totalPages };
}

/**
 * Zugriffsrecht von userId auf ein Rezept: "owner", "write", "read" oder
 * null (existiert nicht oder ist nicht sichtbar - fuer den Aufrufer dasselbe,
 * damit fremde Rezepte nicht einmal ihre Existenz verraten).
 */
function recipeAccess(recipeId, userId) {
  const row = db.prepare(`
    SELECT r.owner_id AS ownerId, s.can_write AS canWrite
    FROM recipes r
    LEFT JOIN recipe_shares s ON s.recipe_id = r.id AND s.user_id = ?
    WHERE r.id = ?
  `).get(userId, recipeId);
  if (!row) return null;
  if (row.ownerId === userId) return "owner";
  if (row.canWrite == null) return null;
  return row.canWrite ? "write" : "read";
}

/** Wie recipeAccess, wirft aber 404/403, wenn das Recht nicht reicht. */
function requireRecipeAccess(recipeId, userId, needed) {
  const access = recipeAccess(recipeId, userId);
  if (!access) throw new HttpError(404, `Rezept "${recipeId}" nicht gefunden.`);
  const rank = { read: 1, write: 2, owner: 3 };
  if (rank[access] < rank[needed]) {
    throw new HttpError(403, needed === "owner"
      ? "Das darf nur der Besitzer des Rezepts."
      : "Dieses Rezept ist für dich nur zum Lesen freigegeben.");
  }
  return access;
}

function getRecipe(id, userId) {
  const access = recipeAccess(id, userId);
  if (!access) return null;
  const recipe = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.long_text AS longText, r.category,
           r.created_at AS createdAt, r.updated_at AS updatedAt,
           r.owner_id AS ownerId, u.username AS ownerName
    FROM recipes r LEFT JOIN users u ON u.id = r.owner_id
    WHERE r.id = ?
  `).get(id);
  recipe.access = access;

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

function insertRecipe(id, data, ownerId) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO recipes (id, name, short_desc, long_text, category, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, data.shortDesc, data.longText, data.category, ownerId, ts, ts);
}

function createRecipe(input, userId) {
  const data = normalizeRecipeInput(input);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeId();
  return transaction(() => {
    if (db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
      throw new HttpError(409, `Es existiert bereits ein Rezept mit der id "${id}".`);
    }
    insertRecipe(id, data, userId);
    writeIngredients(id, data.ingredients);
    writeImages(id, data.images);
    syncCatalogFromIngredients(data.ingredients);
    return getRecipe(id, userId);
  });
}

/** Aendern darf der Besitzer und wer eine Schreib-Freigabe hat. */
function updateRecipe(id, input, userId) {
  const data = normalizeRecipeInput(input);
  return transaction(() => {
    requireRecipeAccess(id, userId, "write");
    db.prepare(`
      UPDATE recipes SET name = ?, short_desc = ?, long_text = ?, category = ?, updated_at = ? WHERE id = ?
    `).run(data.name, data.shortDesc, data.longText, data.category, nowIso(), id);
    writeIngredients(id, data.ingredients);
    writeImages(id, data.images);
    syncCatalogFromIngredients(data.ingredients);
    return getRecipe(id, userId);
  });
}

/** Loeschen darf nur der Besitzer - auch eine Schreib-Freigabe reicht dafuer nicht. */
function deleteRecipe(id, userId) {
  requireRecipeAccess(id, userId, "owner");
  // Zutaten, Bilder und Freigaben verschwinden per ON DELETE CASCADE mit.
  db.prepare("DELETE FROM recipes WHERE id = ?").run(id);
}

/* ----------------------------------------------------------- Freigaben */

function getShares(recipeId, userId) {
  requireRecipeAccess(recipeId, userId, "owner");
  return db.prepare(`
    SELECT s.user_id AS userId, u.username, s.can_write AS canWrite
    FROM recipe_shares s JOIN users u ON u.id = s.user_id
    WHERE s.recipe_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).all(recipeId).map((s) => ({ ...s, canWrite: !!s.canWrite }));
}

/** Ersetzt alle Freigaben eines Rezepts: shares = [{ userId, canWrite }]. */
function setShares(recipeId, userId, shares) {
  if (!Array.isArray(shares)) throw new HttpError(400, "Freigaben muessen eine Liste sein.");
  return transaction(() => {
    requireRecipeAccess(recipeId, userId, "owner");
    db.prepare("DELETE FROM recipe_shares WHERE recipe_id = ?").run(recipeId);
    const insert = db.prepare(
      "INSERT OR REPLACE INTO recipe_shares (recipe_id, user_id, can_write) VALUES (?, ?, ?)"
    );
    for (const share of shares) {
      const target = share && String(share.userId || "");
      if (!target || target === userId) continue; // an sich selbst freigeben ist sinnlos
      if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(target)) {
        throw new HttpError(400, `Benutzer "${target}" existiert nicht.`);
      }
      insert.run(recipeId, target, share.canWrite ? 1 : 0);
    }
    return getShares(recipeId, userId);
  });
}

/* -------------------------------------------------------------- Bilder */

/** Ein Bild bekommt nur, wer das zugehoerige Rezept sehen darf. */
function getImage(id, userId) {
  const image = db.prepare("SELECT id, recipe_id AS recipeId, name, mime, bytes, data FROM images WHERE id = ?").get(id);
  if (!image || !recipeAccess(image.recipeId, userId)) return null;
  return image;
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
function importState(state, userId) {
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
      insertRecipe(id, data, userId);
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
    users: one("SELECT COUNT(*) AS n FROM users"),
  };
}

/* ------------------------------------------------------------ Benutzer */

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

function publicUser(row) {
  return row ? { id: row.id, username: row.username, isAdmin: !!row.isAdmin } : null;
}

function countUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

function getUser(id) {
  return publicUser(db.prepare("SELECT id, username, is_admin AS isAdmin FROM users WHERE id = ?").get(id));
}

/** Liste fuer den Admin (mit Rezeptzahl) bzw. fuer die Freigabe-Auswahl (nur Name). */
function listUsers({ details = false } = {}) {
  if (!details) {
    return db.prepare("SELECT id, username FROM users ORDER BY username COLLATE NOCASE").all();
  }
  return db.prepare(`
    SELECT u.id, u.username, u.is_admin AS isAdmin, u.created_at AS createdAt,
           (SELECT COUNT(*) FROM recipes r WHERE r.owner_id = u.id) AS recipeCount
    FROM users u ORDER BY u.username COLLATE NOCASE
  `).all().map((u) => ({ ...u, isAdmin: !!u.isAdmin }));
}

function createUser(input) {
  const username = normalizeUsername(input && input.username);
  const password = validatePassword(input && input.password);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
    throw new HttpError(409, `Den Benutzernamen "${username}" gibt es schon.`);
  }
  const id = makeId();
  db.prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, username, hashPassword(password), input.isAdmin ? 1 : 0, nowIso());
  return getUser(id);
}

/** Rezepte ohne Besitzer (Bestand aus der Zeit vor Schema 2) gehen an den aeltesten Admin. */
function adoptOrphanRecipes() {
  const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1").get();
  if (!admin) return 0;
  return db.prepare("UPDATE recipes SET owner_id = ? WHERE owner_id IS NULL").run(admin.id).changes;
}

/** Ersteinrichtung: nur moeglich, solange es noch gar keinen Benutzer gibt. */
function setupFirstAdmin(input) {
  return transaction(() => {
    if (countUsers() > 0) throw new HttpError(409, "Die Ersteinrichtung ist bereits erledigt.");
    const user = createUser({ ...input, isAdmin: true });
    adoptOrphanRecipes();
    return user;
  });
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get().n;
}

/** Admin aendert einen Benutzer: { password?, isAdmin? }. */
function updateUser(id, changes, actingUserId) {
  if (!changes || typeof changes !== "object") throw new HttpError(400, "Keine Aenderungen uebergeben.");
  return transaction(() => {
    const user = getUser(id);
    if (!user) throw new HttpError(404, "Benutzer nicht gefunden.");
    if ("isAdmin" in changes && !changes.isAdmin && user.isAdmin) {
      if (id === actingUserId) throw new HttpError(400, "Du kannst dir die Adminrechte nicht selbst entziehen.");
      if (countAdmins() <= 1) throw new HttpError(400, "Es muss mindestens einen Administrator geben.");
    }
    if ("isAdmin" in changes) {
      db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(changes.isAdmin ? 1 : 0, id);
    }
    if ("password" in changes) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(validatePassword(changes.password)), id);
      // Neues Passwort: alle bestehenden Anmeldungen dieses Benutzers beenden.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    return getUser(id);
  });
}

/**
 * Loescht einen Benutzer. Seine Rezepte gehen an den loeschenden Admin ueber,
 * damit nichts verloren geht. Freigaben an den Geloeschten und seine
 * Sitzungen verschwinden per CASCADE.
 */
function deleteUser(id, actingUserId) {
  return transaction(() => {
    const user = getUser(id);
    if (!user) throw new HttpError(404, "Benutzer nicht gefunden.");
    if (id === actingUserId) throw new HttpError(400, "Du kannst dich nicht selbst löschen.");
    const moved = db.prepare("UPDATE recipes SET owner_id = ? WHERE owner_id = ?").run(actingUserId, id).changes;
    // Freigaben an den neuen Besitzer selbst sind jetzt sinnlos.
    db.prepare(`
      DELETE FROM recipe_shares
      WHERE user_id = ? AND recipe_id IN (SELECT id FROM recipes WHERE owner_id = ?)
    `).run(actingUserId, actingUserId);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return { deleted: user.username, recipesMovedTo: actingUserId, recipesMoved: moved };
  });
}

/** Prueft Benutzername + Passwort; liefert den Benutzer oder null. */
function authenticate(username, password) {
  const row = db.prepare("SELECT id, username, is_admin AS isAdmin, password_hash AS hash FROM users WHERE username = ?")
    .get(String(username || "").trim());
  const ok = verifyPassword(String(password || ""), row ? row.hash : DUMMY_HASH);
  return ok && row ? publicUser(row) : null;
}

function changeOwnPassword(userId, currentPassword, newPassword, keepTokenHash) {
  const row = db.prepare("SELECT password_hash AS hash FROM users WHERE id = ?").get(userId);
  if (!row || !verifyPassword(String(currentPassword || ""), row.hash)) {
    throw new HttpError(400, "Das bisherige Passwort stimmt nicht.");
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(validatePassword(newPassword)), userId);
  // Andere Geraete abmelden, die aktuelle Sitzung bleibt.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, keepTokenHash || "");
}

/* ------------------------------------------------------------ Sitzungen */

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
}

/** Legt eine Sitzung an und liefert das Token (nur hier im Klartext). */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, nowIso(), sessionExpiry());
  return token;
}

/** Benutzer zur Sitzung oder null; verlaengert aktiv genutzte Sitzungen. */
function getSessionUser(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.expires_at AS expiresAt, u.id, u.username, u.is_admin AS isAdmin
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  const remaining = Date.parse(row.expiresAt) - Date.now();
  if (remaining <= 0) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  if (remaining < SESSION_RENEW_DAYS * 86400000) {
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(sessionExpiry(), tokenHash);
  }
  return { ...publicUser(row), tokenHash };
}

function deleteSession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
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
function getRecommendations(userId, options = {}) {
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
  const { where, params } = buildRecipeWhere(userId, { search: term });
  const rows = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.owner_id AS ownerId,
           u.username AS ownerName, ing.name AS ingredientName
    FROM recipes r
    LEFT JOIN users u ON u.id = r.owner_id
    LEFT JOIN ingredients ing ON ing.recipe_id = r.id
    ${where}
    ORDER BY r.id, ing.position
  `).all(...params);

  const byRecipe = new Map();
  for (const row of rows) {
    let entry = byRecipe.get(row.id);
    if (!entry) {
      entry = {
        id: row.id, name: row.name, shortDesc: row.shortDesc,
        ownerName: row.ownerId === userId ? null : row.ownerName, ingredients: [],
      };
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
      id: r.id, name: r.name, shortDesc: r.shortDesc, ownerName: r.ownerName,
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
      ownerName: r.ownerName, // null bei eigenen Rezepten
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
  getShares,
  setShares,
  getImage,
  SESSION_DAYS,
  countUsers,
  getUser,
  listUsers,
  createUser,
  setupFirstAdmin,
  updateUser,
  deleteUser,
  authenticate,
  changeOwnPassword,
  createSession,
  getSessionUser,
  deleteSession,
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
};
