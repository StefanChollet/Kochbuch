"use strict";

/* =========================================================================
   REST-API fuer das Kochbuch.

   Alle Routen liegen unter /api. Antworten sind JSON (UTF-8), ausser der
   Bild-Auslieferung, die die Bytes direkt mit ihrem MIME-Typ schickt.
   Fehler kommen einheitlich als { "error": "..." } mit passendem Status.

   Anmeldung: Sitzungs-Cookie (HttpOnly, SameSite=Lax). Ohne gueltige
   Sitzung sind nur /api/health und /api/auth/* (Status, Login,
   Ersteinrichtung) erreichbar, alles andere antwortet mit 401.
   ========================================================================= */

const db = require("./db");
const { HttpError } = db;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // deckt mehrere Bilder je Rezept ab
const SESSION_COOKIE = "kochbuch_session";

// Schutz gegen Passwort-Raten: hoechstens so viele Fehlversuche je IP im Zeitfenster.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, since }

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

/* -------------------------------------------------------- Sitzungen */

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Hinter dem nginx-Proxy kommt HTTPS als X-Forwarded-Proto an. */
function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${db.SESSION_DAYS * 86400}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clientIp(req) {
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "?";
}

function checkLoginRateLimit(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return;
  if (Date.now() - entry.since > LOGIN_WINDOW_MS) { loginFailures.delete(ip); return; }
  if (entry.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, "Zu viele Fehlversuche. Bitte in 15 Minuten nochmal versuchen.");
  }
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() - entry.since > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, since: Date.now() });
  } else {
    entry.count++;
  }
}

/**
 * Schreibende Anfragen von fremden Seiten abweisen: Schickt der Browser
 * einen Origin mit, muss er zum eigenen Host passen. (Zusaetzlich zu
 * SameSite=Lax am Cookie.)
 */
function checkOrigin(req) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  let originHost;
  try { originHost = new URL(origin).host; } catch { originHost = null; }
  if (originHost !== host) throw new HttpError(403, "Anfrage von fremder Herkunft abgelehnt.");
}

/* ------------------------------------------------------------- Routen */

/**
 * Jede Route: [Methode, Pfad-Regex, Handler, Zugriff].
 * Zugriff: "public" (ohne Anmeldung), "user" (Standard) oder "admin".
 * Handler bekommen (req, res, ctx, ...Regex-Gruppen); ctx.user ist der
 * angemeldete Benutzer, ctx.token das Sitzungstoken.
 */
const routes = [
  ["GET", /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, { status: "ok", schemaVersion: db.SCHEMA_VERSION });
  }, "public"],

  /* ---- Anmeldung ---- */
  ["GET", /^\/api\/auth\/status$/, async (req, res, ctx) => {
    sendJson(res, 200, {
      user: ctx.user ? { id: ctx.user.id, username: ctx.user.username, isAdmin: ctx.user.isAdmin } : null,
      setupRequired: db.countUsers() === 0,
    });
  }, "public"],

  // Ersteinrichtung: legt den ersten Administrator an, solange es keinen Benutzer gibt.
  ["POST", /^\/api\/auth\/setup$/, async (req, res) => {
    const body = await readJson(req);
    const user = db.setupFirstAdmin({ username: body.username, password: body.password });
    setSessionCookie(req, res, db.createSession(user.id));
    sendJson(res, 201, { user });
  }, "public"],

  ["POST", /^\/api\/auth\/login$/, async (req, res) => {
    const ip = clientIp(req);
    checkLoginRateLimit(ip);
    const body = await readJson(req);
    const user = db.authenticate(body.username, body.password);
    if (!user) {
      recordLoginFailure(ip);
      throw new HttpError(401, "Benutzername oder Passwort stimmt nicht.");
    }
    loginFailures.delete(ip);
    setSessionCookie(req, res, db.createSession(user.id));
    sendJson(res, 200, { user });
  }, "public"],

  ["POST", /^\/api\/auth\/logout$/, async (req, res, ctx) => {
    db.deleteSession(ctx.token);
    clearSessionCookie(req, res);
    sendEmpty(res, 204);
  }, "public"],

  ["POST", /^\/api\/auth\/password$/, async (req, res, ctx) => {
    const body = await readJson(req);
    db.changeOwnPassword(ctx.user.id, body.currentPassword, body.newPassword, ctx.user.tokenHash);
    sendEmpty(res, 204);
  }],

  /* ---- Benutzerverwaltung ---- */
  // Alle Angemeldeten bekommen die Namensliste (fuer die Freigabe-Auswahl),
  // der Admin zusaetzlich Rechte und Rezeptzahl.
  ["GET", /^\/api\/users$/, async (req, res, ctx) => {
    sendJson(res, 200, db.listUsers({ details: ctx.user.isAdmin }));
  }],

  ["POST", /^\/api\/users$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, db.createUser({ username: body.username, password: body.password, isAdmin: !!body.isAdmin }));
  }, "admin"],

  ["PATCH", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    const body = await readJson(req);
    const changes = {};
    if ("password" in body) changes.password = body.password;
    if ("isAdmin" in body) changes.isAdmin = !!body.isAdmin;
    sendJson(res, 200, db.updateUser(id, changes, ctx.user.id));
  }, "admin"],

  ["DELETE", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.deleteUser(id, ctx.user.id));
  }, "admin"],

  /* ---- Startaufbau ---- */
  ["GET", /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, db.getState());
  }],

  // Empfehlungen aus Kuehlschrank + Suchfilter, siehe db.getRecommendations().
  // ?search=&limit=5&exclude=id1,id2 (zuletzt gezeigte Rezepte, werden gemieden)
  ["GET", /^\/api\/recommendations$/, async (req, res, ctx) => {
    const q = getQuery(req);
    sendJson(res, 200, db.getRecommendations(ctx.user.id, {
      search: q.get("search") || "",
      limit: q.get("limit") || 4,
      exclude: (q.get("exclude") || "").split(",").filter(Boolean),
    }));
  }],

  /* ---- Rezepte ---- */
  // Unterstuetzt ?search=&scope=all|mine|shared&sortBy=name|shortDesc|updatedAt|owner&sortDir=asc|desc&page=&pageSize=
  ["GET", /^\/api\/recipes$/, async (req, res, ctx) => {
    const q = getQuery(req);
    sendJson(res, 200, db.listRecipesPage(ctx.user.id, {
      search: q.get("search") || "",
      scope: q.get("scope") || "all",
      sortBy: q.get("sortBy") || "name",
      sortDir: q.get("sortDir") || "asc",
      page: q.get("page") || 1,
      pageSize: q.get("pageSize") || 20,
    }));
  }],

  ["POST", /^\/api\/recipes$/, async (req, res, ctx) => {
    const recipe = db.createRecipe(await readJson(req), ctx.user.id);
    res.setHeader("Location", `/api/recipes/${recipe.id}`);
    sendJson(res, 201, recipe);
  }],

  ["GET", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    const recipe = db.getRecipe(id, ctx.user.id);
    if (!recipe) throw new HttpError(404, `Rezept "${id}" nicht gefunden.`);
    sendJson(res, 200, recipe);
  }],

  ["PUT", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.updateRecipe(id, await readJson(req), ctx.user.id));
  }],

  ["DELETE", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    db.deleteRecipe(id, ctx.user.id);
    sendEmpty(res, 204);
  }],

  /* ---- Freigaben (nur der Besitzer) ---- */
  ["GET", /^\/api\/recipes\/([^/]+)\/shares$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.getShares(id, ctx.user.id));
  }],

  // Body: [{ userId, canWrite }] - ersetzt alle bisherigen Freigaben.
  ["PUT", /^\/api\/recipes\/([^/]+)\/shares$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.setShares(id, ctx.user.id, await readJson(req)));
  }],

  /* ---- Bilder ---- */
  ["GET", /^\/api\/images\/([^/]+)$/, async (req, res, ctx, id) => {
    const image = db.getImage(id, ctx.user.id);
    if (!image) throw new HttpError(404, `Bild "${id}" nicht gefunden.`);

    // Bilddaten sind unveraenderlich: neue Bytes bekommen immer eine neue id.
    // Darum darf der Browser sie dauerhaft cachen - aber nur privat, nicht
    // in geteilten Caches, weil Bilder nicht mehr oeffentlich sind.
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
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
    });
    res.end(buf);
  }],

  /* ---- Kuehlschrank (gemeinsam fuer alle Benutzer) ---- */
  ["GET", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, db.listFridge());
  }],

  ["POST", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 201, db.addFridgeItem(await readJson(req)));
  }],

  ["DELETE", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, { deleted: db.clearFridge() });
  }],

  ["PATCH", /^\/api\/fridge\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.updateFridgeItem(id, await readJson(req)));
  }],

  ["DELETE", /^\/api\/fridge\/([^/]+)$/, async (req, res, ctx, id) => {
    if (!db.deleteFridgeItem(id)) throw new HttpError(404, `Eintrag "${id}" nicht gefunden.`);
    sendEmpty(res, 204);
  }],

  /* ---- Zutaten-Katalog (gemeinsam) ---- */
  ["GET", /^\/api\/catalog$/, async (req, res) => {
    sendJson(res, 200, db.listCatalog());
  }],

  ["POST", /^\/api\/catalog$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { name: db.addCatalogEntry(body && body.name) });
  }],

  ["DELETE", /^\/api\/catalog\/([^/]+)$/, async (req, res, ctx, name) => {
    if (!db.deleteCatalogEntry(name)) throw new HttpError(404, `Katalogeintrag "${name}" nicht gefunden.`);
    sendEmpty(res, 204);
  }],

  /* ---- Import aus dem alten localStorage-Bestand (landet beim Importierenden) ---- */
  ["POST", /^\/api\/import$/, async (req, res, ctx) => {
    sendJson(res, 200, db.importState(await readJson(req), ctx.user.id));
  }],
];

/**
 * Behandelt eine /api-Anfrage. Gibt false zurueck, wenn der Pfad gar nicht
 * zur API gehoert - dann uebernimmt der statische Teil des Servers.
 */
async function handle(req, res, pathname) {
  if (!pathname.startsWith("/api/") && pathname !== "/api") return false;

  const allowedForPath = new Set();
  for (const [method, pattern, handler, access = "user"] of routes) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    allowedForPath.add(method);
    if (req.method !== method) continue;

    try {
      checkOrigin(req);
      const token = readCookie(req, SESSION_COOKIE);
      const user = db.getSessionUser(token);
      if (access !== "public" && !user) throw new HttpError(401, "Bitte anmelden.");
      if (access === "admin" && !user.isAdmin) throw new HttpError(403, "Dafür braucht es Adminrechte.");
      await handler(req, res, { user, token }, ...match.slice(1).map(decodeURIComponent));
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
