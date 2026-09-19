"use strict";

/* =========================================================================
   REST-API fuer das Kochbuch.

   Alle Routen liegen unter /api. Antworten sind JSON (UTF-8), ausser der
   Bild-Auslieferung, die die Bytes direkt mit ihrem MIME-Typ schickt.
   Fehler kommen einheitlich als { "error": "..." } mit passendem Status.
   ========================================================================= */

const db = require("./db");
const { HttpError } = db;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // deckt mehrere Bilder je Rezept ab

/* ------------------------------------------------------------- Helfer */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Verbindung abraeumen, sonst laedt der Client weiter ins Leere.
        reject(new HttpError(413, `Anfrage zu gross (max. ${MAX_BODY_BYTES / 1024 / 1024} MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Anfrage enthaelt kein gueltiges JSON.");
  }
}

/** Liefert die Query-Parameter einer Anfrage; der Host in der Basis-URL wird nicht verwendet. */
function getQuery(req) {
  return new URL(req.url, "http://internal").searchParams;
}

/* ------------------------------------------------------------- Routen */

/**
 * Jede Route: [Methode, Pfad-Regex, Handler].
 * Die Gruppen der Regex landen als Parameter im Handler.
 */
const routes = [
  ["GET", /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, {
      status: "ok",
      schemaVersion: db.SCHEMA_VERSION,
      stats: db.getStats(),
    });
  }],

  // Alles fuer den Startaufbau in einem Rutsch.
  ["GET", /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, db.getState());
  }],

  // Empfehlungen aus Kuehlschrank + Suchfilter, siehe db.getRecommendations().
  // ?search=&limit=5&exclude=id1,id2 (zuletzt gezeigte Rezepte, werden gemieden)
  ["GET", /^\/api\/recommendations$/, async (req, res) => {
    const q = getQuery(req);
    sendJson(res, 200, db.getRecommendations({
      search: q.get("search") || "",
      limit: q.get("limit") || 4,
      exclude: (q.get("exclude") || "").split(",").filter(Boolean),
    }));
  }],

  /* ---- Rezepte ---- */
  // Unterstuetzt ?search=&sortBy=name|shortDesc|updatedAt&sortDir=asc|desc&page=&pageSize=
  ["GET", /^\/api\/recipes$/, async (req, res) => {
    const q = getQuery(req);
    sendJson(res, 200, db.listRecipesPage({
      search: q.get("search") || "",
      sortBy: q.get("sortBy") || "name",
      sortDir: q.get("sortDir") || "asc",
      page: q.get("page") || 1,
      pageSize: q.get("pageSize") || 20,
    }));
  }],

  ["POST", /^\/api\/recipes$/, async (req, res) => {
    const recipe = db.createRecipe(await readJson(req));
    res.setHeader("Location", `/api/recipes/${recipe.id}`);
    sendJson(res, 201, recipe);
  }],

  ["GET", /^\/api\/recipes\/([^/]+)$/, async (req, res, id) => {
    const recipe = db.getRecipe(id);
    if (!recipe) throw new HttpError(404, `Rezept "${id}" nicht gefunden.`);
    sendJson(res, 200, recipe);
  }],

  ["PUT", /^\/api\/recipes\/([^/]+)$/, async (req, res, id) => {
    sendJson(res, 200, db.updateRecipe(id, await readJson(req)));
  }],

  ["DELETE", /^\/api\/recipes\/([^/]+)$/, async (req, res, id) => {
    if (!db.deleteRecipe(id)) throw new HttpError(404, `Rezept "${id}" nicht gefunden.`);
    sendEmpty(res, 204);
  }],

  /* ---- Bilder ---- */
  ["GET", /^\/api\/images\/([^/]+)$/, async (req, res, id) => {
    const image = db.getImage(id);
    if (!image) throw new HttpError(404, `Bild "${id}" nicht gefunden.`);

    // Bilddaten sind unveraenderlich: neue Bytes bekommen immer eine neue id.
    // Darum darf der Browser sie dauerhaft cachen.
    const etag = `"${image.id}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    const buf = Buffer.from(image.data);
    res.writeHead(200, {
      "Content-Type": image.mime,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
    });
    res.end(buf);
  }],

  /* ---- Kuehlschrank ---- */
  ["GET", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, db.listFridge());
  }],

  ["POST", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 201, db.addFridgeItem(await readJson(req)));
  }],

  ["DELETE", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, { deleted: db.clearFridge() });
  }],

  ["PATCH", /^\/api\/fridge\/([^/]+)$/, async (req, res, id) => {
    sendJson(res, 200, db.updateFridgeItem(id, await readJson(req)));
  }],

  ["DELETE", /^\/api\/fridge\/([^/]+)$/, async (req, res, id) => {
    if (!db.deleteFridgeItem(id)) throw new HttpError(404, `Eintrag "${id}" nicht gefunden.`);
    sendEmpty(res, 204);
  }],

  /* ---- Zutaten-Katalog ---- */
  ["GET", /^\/api\/catalog$/, async (req, res) => {
    sendJson(res, 200, db.listCatalog());
  }],

  ["GET", /^\/api\/category-catalog$/, async (req, res) => {
    sendJson(res, 200, db.listCategoryCatalog());
  }],

  ["POST", /^\/api\/catalog$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { name: db.addCatalogEntry(body && body.name) });
  }],

  ["DELETE", /^\/api\/catalog\/([^/]+)$/, async (req, res, name) => {
    if (!db.deleteCatalogEntry(name)) throw new HttpError(404, `Katalogeintrag "${name}" nicht gefunden.`);
    sendEmpty(res, 204);
  }],

  /* ---- Import aus dem alten localStorage-Bestand ---- */
  ["POST", /^\/api\/import$/, async (req, res) => {
    sendJson(res, 200, db.importState(await readJson(req)));
  }],
];

/**
 * Behandelt eine /api-Anfrage. Gibt false zurueck, wenn der Pfad gar nicht
 * zur API gehoert - dann uebernimmt der statische Teil des Servers.
 */
async function handle(req, res, pathname) {
  if (!pathname.startsWith("/api/") && pathname !== "/api") return false;

  const allowedForPath = new Set();
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    allowedForPath.add(method);
    if (req.method !== method) continue;

    try {
      await handler(req, res, ...match.slice(1).map(decodeURIComponent));
    } catch (err) {
      if (res.headersSent) { res.destroy(); return true; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(`API-Fehler bei ${req.method} ${pathname}:`, err);
        sendJson(res, 500, { error: "Interner Serverfehler - Details siehe Server-Log." });
      }
    }
    return true;
  }

  if (allowedForPath.size > 0) {
    // Pfad existiert, aber nicht mit dieser Methode.
    res.setHeader("Allow", [...allowedForPath].join(", "));
    sendJson(res, 405, { error: `Methode ${req.method} ist fuer ${pathname} nicht erlaubt.` });
  } else {
    sendJson(res, 404, { error: `Unbekannter API-Endpunkt: ${pathname}` });
  }
  return true;
}

module.exports = { handle, MAX_BODY_BYTES };
