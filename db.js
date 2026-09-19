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

-- Kategorien eines Rezepts (mehrere moeglich). NOCASE im Primaerschluessel:
-- "Suppe" und "suppe" sind dieselbe Kategorie und koennen nicht doppelt vorkommen.
CREATE TABLE IF NOT EXISTS recipe_categories (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL COLLATE NOCASE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (recipe_id, name)
);

-- Vorschlagsliste aller bisher vergebenen Kategorien (wie ingredient_catalog).
CREATE TABLE IF NOT EXISTS category_catalog (
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

const RECIPE_SORT_COLUMNS = {
  name: "r.name COLLATE NOCASE",
  shortDesc: "r.short_desc COLLATE NOCASE",
  updatedAt: "r.updated_at",
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
           (SELECT COUNT(*) FROM ingredients i WHERE i.recipe_id = r.id) AS ingredientCount,
           (SELECT COUNT(*) FROM images g      WHERE g.recipe_id = r.id) AS imageCount,
           (SELECT id FROM images g WHERE g.recipe_id = r.id ORDER BY position LIMIT 1) AS firstImageId
    FROM recipes r
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

  recipe.categories = db.prepare(`
    SELECT name FROM recipe_categories WHERE recipe_id = ? ORDER BY position
  `).all(id).map((row) => row.name);

  return recipe;
}

const MAX_CATEGORIES_PER_RECIPE = 20;

/** Kategorien eines Rezepts komplett neu schreiben und in den Vorschlagskatalog uebernehmen. */
function writeCategories(recipeId, categories) {
  db.prepare("DELETE FROM recipe_categories WHERE recipe_id = ?").run(recipeId);
  const insert = db.prepare("INSERT INTO recipe_categories (recipe_id, name, position) VALUES (?, ?, ?)");
  const catalog = db.prepare("INSERT OR IGNORE INTO category_catalog (name) VALUES (?)");
  categories.forEach((name, index) => {
    insert.run(recipeId, name, index);
    catalog.run(name);
  });
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
    categories: normalizeCategories(input.categories),
  };
}

/** Kategorien als Textliste: getrimmt, leere verworfen, ohne Doppelte (ohne Beachtung der Gross-/Kleinschreibung). */
function normalizeCategories(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Feld "categories" muss eine Liste sein.');
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const name = text(entry, "categories[]", { max: 40 }).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  if (result.length > MAX_CATEGORIES_PER_RECIPE) {
    throw new HttpError(400, `Zu viele Kategorien (max. ${MAX_CATEGORIES_PER_RECIPE} pro Rezept).`);
  }
  return result;
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
    writeCategories(id, data.categories);
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
    writeCategories(id, data.categories);
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

function listCategoryCatalog() {
  return db.prepare("SELECT name FROM category_catalog ORDER BY name COLLATE NOCASE").all().map((r) => r.name);
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
      writeCategories(id, data.categories);
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
  return { fridge: listFridge(), ingredientCatalog: listCatalog(), categoryCatalog: listCategoryCatalog() };
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
  listCategoryCatalog,
  addCatalogEntry,
  deleteCatalogEntry,
  importState,
  getState,
  getStats,
  getRecommendations,
};
