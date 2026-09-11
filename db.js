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

const SCHEMA_VERSION = 1;
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
`;

function open(file) {
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) > SCHEMA_VERSION) {
    throw new Error(
      `Datenbank hat Schema-Version ${row.value}, dieser Server kennt nur ${SCHEMA_VERSION}.`
    );
  }
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

/** Uebersicht - bewusst ohne Langtext und ohne Bilddaten. */
function listRecipes() {
  return db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, r.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM ingredients i WHERE i.recipe_id = r.id) AS ingredientCount,
           (SELECT COUNT(*) FROM images g      WHERE g.recipe_id = r.id) AS imageCount
    FROM recipes r
    ORDER BY r.name COLLATE NOCASE
  `).all();
}

function getRecipe(id) {
  const recipe = db.prepare(`
    SELECT id, name, short_desc AS shortDesc, long_text AS longText,
           created_at AS createdAt, updated_at AS updatedAt
    FROM recipes WHERE id = ?
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
    ingredients,
    images,
  };
}

function createRecipe(input) {
  const data = normalizeRecipeInput(input);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeId();
  return transaction(() => {
    if (db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id)) {
      throw new HttpError(409, `Es existiert bereits ein Rezept mit der id "${id}".`);
    }
    const ts = nowIso();
    db.prepare(`
      INSERT INTO recipes (id, name, short_desc, long_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.shortDesc, data.longText, ts, ts);
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
      UPDATE recipes SET name = ?, short_desc = ?, long_text = ?, updated_at = ? WHERE id = ?
    `).run(data.name, data.shortDesc, data.longText, nowIso(), id);
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
function importState(state) {
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
      const ts = nowIso();
      db.prepare(`
        INSERT INTO recipes (id, name, short_desc, long_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, data.name, data.shortDesc, data.longText, ts, ts);
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
  return { recipes: listRecipes(), fridge: listFridge(), ingredientCatalog: listCatalog() };
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
  };
}

module.exports = {
  HttpError,
  SCHEMA_VERSION,
  MAX_IMAGE_BYTES,
  open,
  close,
  makeId,
  listRecipes,
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
};
