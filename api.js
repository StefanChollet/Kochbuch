"use strict";

/* =========================================================================
   REST-API fuer das Kochbuch.

   Alle Routen liegen unter /api. Antworten sind JSON (UTF-8), ausser der
   Bild-Auslieferung, die die Bytes direkt mit ihrem MIME-Typ schickt.
   Fehler kommen einheitlich als { "error": "..." } mit passendem Status.

   Anmeldung: Sitzungs-Cookie (HttpOnly, SameSite=Lax). Ohne gueltige
   Sitzung sind nur /api/health und /api/auth/* erreichbar, alles andere
   antwortet mit 401. Lesen duerfen alle Angemeldeten; Schreiben (Rezepte,
   Kuehlschrank, Katalog, Benutzerverwaltung) nur Admin und Rolle "rw".
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

/** 404, wenn es das Rezept nicht gibt oder es fuer diesen Benutzer nicht sichtbar ist. */
function requireRecipeAccess(ctx, id) {
  if (!db.canAccessRecipe(ctx.account, id)) throw new HttpError(404, `Rezept "${id}" nicht gefunden.`);
}

/** Was der Client ueber den angemeldeten Benutzer wissen muss. */
function describeAccount(account) {
  return { id: account.id, username: account.username, role: account.role, canWrite: db.canWrite(account) };
}

/* ------------------------------------------------------------- Routen */

/**
 * Jede Route: [Methode, Pfad-Regex, Handler, Zugriff].
 * Zugriff: "public" (ohne Anmeldung), "read" (jeder Angemeldete, Standard)
 * "write" (Admin und Rolle "rw") oder "admin" (nur der Admin).
 * Handler bekommen (req, res, ctx, ...Regex-Gruppen); ctx.account ist der
 * angemeldete Benutzer, ctx.token das Sitzungstoken.
 */
const routes = [
  ["GET", /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, { status: "ok", schemaVersion: db.SCHEMA_VERSION });
  }, "public"],

  /* ---- Anmeldung ---- */
  // Benutzernamen fuer die Auswahlliste im Anmeldefenster (bewusst ohne
  // Anmeldung erreichbar - nur Namen, keine Rollen oder sonstigen Daten).
  ["GET", /^\/api\/auth\/users$/, async (req, res) => {
    sendJson(res, 200, { usernames: db.listUsernames() });
  }, "public"],

  ["GET", /^\/api\/auth\/status$/, async (req, res, ctx) => {
    sendJson(res, 200, { user: ctx.account ? describeAccount(ctx.account) : null });
  }, "public"],

  ["POST", /^\/api\/auth\/login$/, async (req, res) => {
    const ip = clientIp(req);
    checkLoginRateLimit(ip);
    const body = await readJson(req);
    const account = db.authenticate(body.username, body.password);
    if (!account) {
      recordLoginFailure(ip);
      throw new HttpError(401, "Benutzername oder Passwort stimmt nicht.");
    }
    loginFailures.delete(ip);
    setSessionCookie(req, res, db.createSession(account.id));
    sendJson(res, 200, { user: describeAccount(account) });
  }, "public"],

  ["POST", /^\/api\/auth\/logout$/, async (req, res, ctx) => {
    db.deleteSession(ctx.token);
    clearSessionCookie(req, res);
    sendEmpty(res, 204);
  }, "public"],

  // Eigenes Passwort - darf jeder Angemeldete, auch mit Nur-lesen-Rechten.
  ["POST", /^\/api\/auth\/password$/, async (req, res, ctx) => {
    const body = await readJson(req);
    db.changeOwnPassword(ctx.account.id, body.currentPassword, body.newPassword, ctx.account.tokenHash);
    sendEmpty(res, 204);
  }],

  /* ---- Benutzerverwaltung (nur der Admin) ---- */
  ["GET", /^\/api\/users$/, async (req, res) => {
    sendJson(res, 200, db.listAccounts());
  }, "admin"],

  // Erfasst werden Name, Passwort und Rechte; die id setzt die App.
  ["POST", /^\/api\/users$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, db.createAccount({ username: body.username, password: body.password, role: body.role }));
  }, "admin"],

  // Body: { role } - aendern laesst sich nur das Recht, der Admin (id 0) ist gesperrt.
  ["PATCH", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    const body = await readJson(req);
    if (Object.keys(body).some((key) => key !== "role")) {
      throw new HttpError(400, "Geändert werden können nur die Rechte.");
    }
    sendJson(res, 200, db.updateAccountRole(id, body.role));
  }, "admin"],

  ["DELETE", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.deleteAccount(id, ctx.account.id));
  }, "admin"],

  // Alles fuer den Startaufbau in einem Rutsch.
  ["GET", /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, db.getState());
  }],

  // Empfehlungen aus Kuehlschrank + Suchfilter, siehe db.getRecommendations().
  // ?search=&limit=5&exclude=id1,id2 (zuletzt gezeigte Rezepte, werden gemieden)
  ["GET", /^\/api\/recommendations$/, async (req, res, ctx) => {
    const q = getQuery(req);
    sendJson(res, 200, db.getRecommendations({
      ownerId: db.recipeOwnerFilter(ctx.account),
      search: q.get("search") || "",
      limit: q.get("limit") || 4,
      exclude: (q.get("exclude") || "").split(",").filter(Boolean),
    }));
  }],

  /* ---- Rezepte ---- */
  // Sichtbarkeit: "rw" sieht nur die eigenen Rezepte, Admin und "r" alle
  // (db.recipeOwnerFilter). Fremde Rezepte gelten als "nicht gefunden".
  // Unterstuetzt ?search=&sortBy=name|shortDesc|updatedAt&sortDir=asc|desc&page=&pageSize=
  ["GET", /^\/api\/recipes$/, async (req, res, ctx) => {
    const q = getQuery(req);
    sendJson(res, 200, db.listRecipesPage({
      ownerId: db.recipeOwnerFilter(ctx.account),
      search: q.get("search") || "",
      sortBy: q.get("sortBy") || "name",
      sortDir: q.get("sortDir") || "asc",
      page: q.get("page") || 1,
      pageSize: q.get("pageSize") || 20,
    }));
  }],

  ["POST", /^\/api\/recipes$/, async (req, res, ctx) => {
    const recipe = db.createRecipe(await readJson(req), ctx.account.id);
    res.setHeader("Location", `/api/recipes/${recipe.id}`);
    sendJson(res, 201, recipe);
  }, "write"],

  ["GET", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    requireRecipeAccess(ctx, id);
    sendJson(res, 200, db.getRecipe(id));
  }],

  ["PUT", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    requireRecipeAccess(ctx, id);
    sendJson(res, 200, db.updateRecipe(id, await readJson(req)));
  }, "write"],

  ["DELETE", /^\/api\/recipes\/([^/]+)$/, async (req, res, ctx, id) => {
    requireRecipeAccess(ctx, id);
    db.deleteRecipe(id);
    sendEmpty(res, 204);
  }, "write"],

  /* ---- Kochansicht (nur lesen, braucht Anmeldung + Code) ---- */
  // Neuer Code fuer ein sichtbares Rezept - Leserecht genuegt. Wer den
  // Link bekommt, darf genau dieses eine Rezept lesen (bewusstes Teilen).
  ["POST", /^\/api\/recipes\/([^/]+)\/views$/, async (req, res, ctx, id) => {
    requireRecipeAccess(ctx, id);
    const code = db.createRecipeView(id, ctx.account.id);
    sendJson(res, 201, { code, url: `/kochansicht.html?code=${code}` });
  }],

  // Liefert genau das eine Rezept zum Code - sonst nichts.
  ["GET", /^\/api\/views\/([^/]+)$/, async (req, res, ctx, code) => {
    const recipe = db.getRecipeByView(code);
    if (!recipe) throw new HttpError(404, "Diese Kochansicht gibt es nicht (mehr).");
    sendJson(res, 200, recipe);
  }],

  /* ---- Bilder ---- */
  ["GET", /^\/api\/images\/([^/]+)$/, async (req, res, ctx, id) => {
    const image = db.getImage(id);
    if (!image) throw new HttpError(404, `Bild "${id}" nicht gefunden.`);

    // Bilddaten sind unveraenderlich: neue Bytes bekommen immer eine neue id.
    // Darum darf der Browser sie dauerhaft cachen - aber nur privat, nicht
    // in geteilten Caches, weil Bilder nur fuer Angemeldete sind.
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

  /* ---- Kuehlschrank ---- */
  ["GET", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, db.listFridge());
  }],

  ["POST", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 201, db.addFridgeItem(await readJson(req)));
  }, "write"],

  ["DELETE", /^\/api\/fridge$/, async (req, res) => {
    sendJson(res, 200, { deleted: db.clearFridge() });
  }, "write"],

  ["PATCH", /^\/api\/fridge\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.updateFridgeItem(id, await readJson(req)));
  }, "write"],

  ["DELETE", /^\/api\/fridge\/([^/]+)$/, async (req, res, ctx, id) => {
    if (!db.deleteFridgeItem(id)) throw new HttpError(404, `Eintrag "${id}" nicht gefunden.`);
    sendEmpty(res, 204);
  }, "write"],

  /* ---- Zutaten-Katalog ---- */
  ["GET", /^\/api\/catalog$/, async (req, res) => {
    sendJson(res, 200, db.listCatalog());
  }],

  ["POST", /^\/api\/catalog$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { name: db.addCatalogEntry(body && body.name) });
  }, "write"],

  ["DELETE", /^\/api\/catalog\/([^/]+)$/, async (req, res, ctx, name) => {
    if (!db.deleteCatalogEntry(name)) throw new HttpError(404, `Katalogeintrag "${name}" nicht gefunden.`);
    sendEmpty(res, 204);
  }, "write"],

  /* ---- Import aus dem alten localStorage-Bestand ---- */
  ["POST", /^\/api\/import$/, async (req, res, ctx) => {
    sendJson(res, 200, db.importState(await readJson(req), ctx.account.id));
  }, "write"],
];

/**
 * Behandelt eine /api-Anfrage. Gibt false zurueck, wenn der Pfad gar nicht
 * zur API gehoert - dann uebernimmt der statische Teil des Servers.
 */
async function handle(req, res, pathname) {
  if (!pathname.startsWith("/api/") && pathname !== "/api") return false;

  const allowedForPath = new Set();
  for (const [method, pattern, handler, access = "read"] of routes) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    allowedForPath.add(method);
    if (req.method !== method) continue;

    try {
      checkOrigin(req);
      const token = readCookie(req, SESSION_COOKIE);
      const account = db.getSessionAccount(token);
      if (access !== "public" && !account) throw new HttpError(401, "Bitte anmelden.");
      if (access === "write" && !db.canWrite(account)) {
        throw new HttpError(403, "Dafür fehlen die Rechte – dieser Benutzer darf nur lesen.");
      }
      if (access === "admin" && account.role !== "admin") {
        throw new HttpError(403, "Die Benutzerverwaltung steht nur dem Admin zur Verfügung.");
      }
      await handler(req, res, { account, token }, ...match.slice(1).map(decodeURIComponent));
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
