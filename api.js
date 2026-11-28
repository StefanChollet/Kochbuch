"use strict";

/* =========================================================================
   REST-API von Travelfy.

   Alle Routen liegen unter /api. Antworten sind JSON (UTF-8), ausser der
   Bild-Auslieferung, die die Bytes direkt mit ihrem MIME-Typ schickt.
   Fehler kommen einheitlich als { "error": "..." } mit passendem Status.

   Anmeldung: eigenes Sitzungs-Cookie "travelfy_session" (HttpOnly,
   SameSite=Strict). Ohne gueltige Sitzung sind nur /api/health und
   /api/auth/* erreichbar, alles andere antwortet mit 401. Lesen duerfen
   alle Angemeldeten; Schreiben nur Admin und Rolle "rw".
   ========================================================================= */

const db = require("./db");
const { HttpError } = db;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // deckt mehrere Bilder je Reise ab
// Eigener Name: Cookies unterscheiden nicht nach Port. Laufen Travelfy und
// eine andere App auf demselben Rechner, darf sich nichts ueberschreiben.
const SESSION_COOKIE = "travelfy_session";
// Das Cookie gilt nur fuer den eigenen Unterpfad (z.B. /travelfy/): andere
// Apps unter demselben Host bekommen die Travelfy-Sitzung nie zu sehen.
let cookiePath = "/";

/** Vom Server beim Start gesetzt: { base: "/travelfy" } */
function configure({ base = "" } = {}) {
  cookiePath = `${base}/`;
}

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
  const type = req.headers["content-type"] || "";
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  // Nur echtes JSON - ein einfaches HTML-Formular einer fremden Seite kann
  // diesen Typ nicht senden.
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Erwartet wird Content-Type application/json.");
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Anfrage enthaelt kein gueltiges JSON.");
  }
}

function getQuery(req) {
  return new URL(req.url, "http://internal").searchParams;
}

/* -------------------------------------------------------- Sitzungen */

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Hinter einem Proxy kommt HTTPS als X-Forwarded-Proto an. */
function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req, res, token) {
  // SameSite=Strict: Kommt man ueber einen Link von irgendwo anders her,
  // schickt der Browser das Cookie gar nicht erst mit.
  const parts = [
    `${SESSION_COOKIE}=${token}`, `Path=${cookiePath}`, "HttpOnly", "SameSite=Strict",
    `Max-Age=${db.SESSION_DAYS * 86400}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, `Path=${cookiePath}`, "HttpOnly", "SameSite=Strict", "Max-Age=0"];
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

function requireTripAccess(ctx, id) {
  if (!db.canAccessTrip(ctx.account, id)) throw new HttpError(404, `Reise "${id}" nicht gefunden.`);
}

function describeAccount(account) {
  return { id: account.id, username: account.username, role: account.role, canWrite: db.canWrite(account) };
}

/* ------------------------------------------------------------- Routen */

/**
 * Jede Route: [Methode, Pfad-Regex, Handler, Zugriff].
 * Zugriff: "public" (ohne Anmeldung), "read" (jeder Angemeldete, Standard),
 * "write" (Admin und Rolle "rw") oder "admin" (nur der Admin).
 */
const routes = [
  ["GET", /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, { status: "ok", app: db.APP_ID, schemaVersion: db.SCHEMA_VERSION });
  }, "public"],

  /* ---- Anmeldung ---- */
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

  ["POST", /^\/api\/auth\/password$/, async (req, res, ctx) => {
    const body = await readJson(req);
    db.changeOwnPassword(ctx.account.id, body.currentPassword, body.newPassword, ctx.account.tokenHash);
    sendEmpty(res, 204);
  }],

  /* ---- Benutzerverwaltung (nur der Admin) ---- */
  ["GET", /^\/api\/users$/, async (req, res) => {
    sendJson(res, 200, db.listAccounts());
  }, "admin"],

  ["POST", /^\/api\/users$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, db.createAccount({ username: body.username, password: body.password, role: body.role }));
  }, "admin"],

  ["PATCH", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    const body = await readJson(req);
    if (Object.keys(body).some((key) => key !== "role")) {
      throw new HttpError(400, "Geändert werden können nur die Rechte.");
    }
    sendJson(res, 200, db.updateAccountRole(id, body.role));
  }, "admin"],

  ["POST", /^\/api\/users\/([^/]+)\/password$/, async (req, res, ctx, id) => {
    const body = await readJson(req);
    sendJson(res, 200, db.setAccountPassword(id, ctx.account.id, body.adminPassword, body.newPassword));
  }, "admin"],

  ["DELETE", /^\/api\/users\/([^/]+)$/, async (req, res, ctx, id) => {
    sendJson(res, 200, db.deleteAccount(id, ctx.account.id));
  }, "admin"],

  /* ---- Reisen ---- */
  ["GET", /^\/api\/state$/, async (req, res) => {
    sendJson(res, 200, { categoryOptions: db.listCategoryOptions() });
  }],

  // ?search=&category=&createdBy=&sortBy=name|destination|startDate|updatedAt|createdBy
  // &fromDate=JJJJ-MM-TT&sortDir=asc|desc&page=&pageSize=   (category "-" = ohne Reiseart)
  ["GET", /^\/api\/trips$/, async (req, res, ctx) => {
    const q = getQuery(req);
    sendJson(res, 200, db.listTripsPage({
      ownerId: db.tripOwnerFilter(ctx.account),
      search: q.get("search") || "",
      category: q.get("category") || "",
      createdBy: q.get("createdBy") || "",
      fromDate: q.get("fromDate") || "",
      sortBy: q.get("sortBy") || "name",
      sortDir: q.get("sortDir") || "asc",
      page: q.get("page") || 1,
      pageSize: q.get("pageSize") || 20,
    }));
  }],

  ["GET", /^\/api\/trip-filters$/, async (req, res, ctx) => {
    sendJson(res, 200, db.listTripFilters(db.tripOwnerFilter(ctx.account)));
  }],

  ["POST", /^\/api\/trips$/, async (req, res, ctx) => {
    const trip = db.createTrip(await readJson(req), ctx.account.id);
    res.setHeader("Location", `trips/${trip.id}`);
    sendJson(res, 201, trip);
  }, "write"],

  ["GET", /^\/api\/trips\/([^/]+)$/, async (req, res, ctx, id) => {
    requireTripAccess(ctx, id);
    sendJson(res, 200, db.getTrip(id));
  }],

  ["PUT", /^\/api\/trips\/([^/]+)$/, async (req, res, ctx, id) => {
    requireTripAccess(ctx, id);
    sendJson(res, 200, db.updateTrip(id, await readJson(req)));
  }, "write"],

  ["DELETE", /^\/api\/trips\/([^/]+)$/, async (req, res, ctx, id) => {
    requireTripAccess(ctx, id);
    db.deleteTrip(id);
    sendEmpty(res, 204);
  }, "write"],

  /* ---- Bilder ---- */
  // Foto oder Zeichenblatt sofort dauerhaft zur Reise speichern
  // { name, dataUrl, scene?, createdAt?, replaces? } -> das gespeicherte Bild
  ["POST", /^\/api\/trips\/([^/]+)\/images$/, async (req, res, ctx, id) => {
    requireTripAccess(ctx, id);
    sendJson(res, 201, db.addImage(id, await readJson(req)));
  }, "write"],

  // Reihenfolge der Bilder sofort speichern: { ids: [...] }
  ["PUT", /^\/api\/trips\/([^/]+)\/image-order$/, async (req, res, ctx, id) => {
    requireTripAccess(ctx, id);
    const body = await readJson(req);
    sendJson(res, 200, { ids: db.setImageOrder(id, body && body.ids) });
  }, "write"],

  // Ein Bild sofort endgueltig loeschen
  ["DELETE", /^\/api\/images\/([^/]+)$/, async (req, res, ctx, id) => {
    const image = db.getImage(id);
    if (!image || !db.canAccessTrip(ctx.account, image.tripId)) throw new HttpError(404, `Bild "${id}" nicht gefunden.`);
    db.deleteImage(id);
    sendEmpty(res, 204);
  }, "write"],

  // Inhalt eines Zeichenblatts zum erneuten Bearbeiten (nur fuer Reisen, die man sehen darf)
  ["GET", /^\/api\/images\/([^/]+)\/scene$/, async (req, res, ctx, id) => {
    const row = db.getImageScene(id);
    if (!row || !db.canAccessTrip(ctx.account, row.tripId)) throw new HttpError(404, `Bild "${id}" nicht gefunden.`);
    if (!row.scene) throw new HttpError(404, "Dieses Bild ist kein bearbeitbares Zeichenblatt.");
    const body = Buffer.from(row.scene, "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(body);
  }],

  ["GET", /^\/api\/images\/([^/]+)$/, async (req, res, ctx, id) => {
    const image = db.getImage(id);
    // Nur Bilder von Reisen, die dieser Benutzer auch sehen darf.
    if (!image || !db.canAccessTrip(ctx.account, image.tripId)) {
      throw new HttpError(404, `Bild "${id}" nicht gefunden.`);
    }
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
];

/**
 * Behandelt eine /api-Anfrage. Gibt false zurueck, wenn der Pfad gar nicht
 * zur API gehoert - dann uebernimmt der statische Teil des Servers.
 * Die Herkunftspruefung (keine Anfragen anderer Anwendungen) macht server.js
 * fuer alle Anfragen vorab.
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
      const token = readCookie(req, SESSION_COOKIE);
      const account = db.getSessionAccount(token);
      if (access !== "public" && !account) throw new HttpError(401, "Bitte anmelden.");
      if (access === "write" && !db.canWrite(account)) {
        throw new HttpError(403, "Dafür fehlen die Rechte – dieser Benutzer darf nur lesen.");
      }
      if (access === "admin" && account.role !== "admin") {
        throw new HttpError(403, "Die Benutzerverwaltung steht nur dem Admin zur Verfügung.");
      }
      let params;
      try { params = match.slice(1).map(decodeURIComponent); } catch { throw new HttpError(400, "Ungültige Adresse."); }
      await handler(req, res, { account, token }, ...params);
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
    res.setHeader("Allow", [...allowedForPath].join(", "));
    sendJson(res, 405, { error: `Methode ${req.method} ist fuer ${pathname} nicht erlaubt.` });
  } else {
    sendJson(res, 404, { error: `Unbekannter API-Endpunkt: ${pathname}` });
  }
  return true;
}

module.exports = { handle, configure, MAX_BODY_BYTES, SESSION_COOKIE };
