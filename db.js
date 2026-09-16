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

  let where = "";
  const params = [];
  if (term) {
    where = `WHERE r.name LIKE ? ESCAPE '\\'
       OR r.short_desc LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM ingredients i WHERE i.recipe_id = r.id AND i.name LIKE ? ESCAPE '\\')`;
    const like = `%${escapeLike(term)}%`;
    params.push(like, like, like);
  }

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
  // Die Rezeptliste kommt bewusst nicht hierher - sie wird paginiert ueber
  // listRecipesPage()/GET /api/recipes geladen, damit /api/state bei vielen
  // Rezepten klein und schnell bleibt.
  return { fridge: listFridge(), ingredientCatalog: listCatalog() };
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

const DEFAULT_RECOMMENDATION_LIMIT = 5;
const MAX_RECOMMENDATION_LIMIT = 20;

/** Mischt ein Array in-place (Fisher-Yates) - fuer die Zufallsauswahl. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Empfiehlt Rezepte anhand des Kuehlschrank-Bestands: je mehr Zutaten
 * eines Rezepts bereits im Kuehlschrank stehen, desto weiter oben. Der
 * Namensabgleich ist bewusst tolerant (Teilstring, case-insensitive) in
 * beide Richtungen, weil Kuehlschrank- und Zutatennamen nicht aus
 * demselben kontrollierten Vokabular stammen ("Zwiebel" im Kuehlschrank
 * soll z.B. auch "Zwiebeln" in einem Rezept treffen).
 *
 * Ist der Kuehlschrank leer oder passt kein Rezept, wird mit einer
 * zufaelligen Auswahl aufgefuellt - basedOnFridge zeigt dem Client, ob die
 * Liste (ganz oder teilweise) eine echte Grundlage hat oder nur zum
 * Stoebern gedacht ist.
 */
function getRecommendations(options = {}) {
  const limit = Math.min(
    MAX_RECOMMENDATION_LIMIT,
    Math.max(1, Math.trunc(Number(options.limit)) || DEFAULT_RECOMMENDATION_LIMIT)
  );

  const fridgeNames = listFridge()
    .map((f) => f.name.trim().toLowerCase())
    .filter(Boolean);

  const rows = db.prepare(`
    SELECT r.id, r.name, r.short_desc AS shortDesc, i.name AS ingredientName
    FROM recipes r
    LEFT JOIN ingredients i ON i.recipe_id = r.id
  `).all();

  const byRecipe = new Map();
  for (const row of rows) {
    let entry = byRecipe.get(row.id);
    if (!entry) {
      entry = { id: row.id, name: row.name, shortDesc: row.shortDesc, ingredientNames: [] };
      byRecipe.set(row.id, entry);
    }
    if (row.ingredientName) entry.ingredientNames.push(row.ingredientName);
  }

  const matchesFridge = (ingredientName) => {
    const n = ingredientName.trim().toLowerCase();
    if (!n) return false;
    return fridgeNames.some((f) => n.includes(f) || f.includes(n));
  };

  const scored = [...byRecipe.values()].map((r) => {
    const totalIngredients = r.ingredientNames.length;
    const matchCount = r.ingredientNames.filter(matchesFridge).length;
    return {
      id: r.id,
      name: r.name,
      shortDesc: r.shortDesc,
      totalIngredients,
      matchCount,
      matchRatio: totalIngredients ? matchCount / totalIngredients : 0,
    };
  });

  let picked;
  let basedOnFridge;

  if (fridgeNames.length === 0) {
    basedOnFridge = false;
    picked = shuffle(scored).slice(0, limit);
  } else {
    const withMatches = scored
      .filter((r) => r.matchCount > 0)
      // Mehr treffende Zutaten zuerst, bei Gleichstand die Rezepte, bei
      // denen der Kuehlschrank einen groesseren Anteil abdeckt, dann die
      // mit weniger Zutaten insgesamt (schneller komplett zu beschaffen).
      .sort((a, b) => b.matchCount - a.matchCount || b.matchRatio - a.matchRatio || a.totalIngredients - b.totalIngredients);

    picked = withMatches.slice(0, limit);
    basedOnFridge = picked.length > 0;

    if (picked.length < limit) {
      const usedIds = new Set(picked.map((r) => r.id));
      const filler = shuffle(scored.filter((r) => !usedIds.has(r.id))).slice(0, limit - picked.length);
      picked = [...picked, ...filler];
    }
  }

  if (picked.length === 0) return { items: [], basedOnFridge: false };

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

  const items = picked.map((r) => ({
    id: r.id,
    name: r.name,
    shortDesc: r.shortDesc,
    matchCount: r.matchCount,
    totalIngredients: r.totalIngredients,
    thumbnailUrl: thumbByRecipe.has(r.id) ? `/api/images/${thumbByRecipe.get(r.id)}` : null,
  }));

  return { items, basedOnFridge };
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
  addCatalogEntry,
  deleteCatalogEntry,
  importState,
  getState,
  getStats,
  getRecommendations,
};
