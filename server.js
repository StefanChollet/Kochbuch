"use strict";

/*
  Webserver von Travelfy.

  Aufgaben:
    1. Sprung-Sperre: Anfragen, die von einer anderen Anwendung ausgeloest
       wurden (Link, Formular, Bild, Skript, iframe), werden abgewiesen.
    2. /api/...     -> REST-API (siehe api.js), Daten in SQLite (siehe db.js)
    3. alles andere -> statische Dateien aus ./public

  Nur Node.js-Standardmodule, keine Abhaengigkeiten, kein npm install.

  Start:  node server.js          (Port 3001)
          node server.js 8081     (anderer Port)
  Umgebung:
          TRAVELFY_DB=pfad.sqlite node server.js
          TRAVELFY_ADMIN_PASSWORD=...  Startpasswort des Admins, nur beim
                                       allerersten Start (sonst zufaellig,
                                       steht dann einmalig im Log)
*/

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const db = require("./db");
const api = require("./api");

const PUBLIC_DIR = path.join(__dirname, "public");
// Bewusst nicht 3000: dort laeuft ueblicherweise das Kochbuch.
const PORT = Number(process.argv[2]) || Number(process.env.TRAVELFY_PORT) || 3001;
const DB_FILE = process.env.TRAVELFY_DB
  ? path.resolve(process.env.TRAVELFY_DB)
  : path.join(__dirname, "travelfy.sqlite");
const INDEX = "index.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------- Sicherheits-Kopfzeilen */

// Gilt fuer jede Antwort. Kern der Abschottung gegen andere Anwendungen:
//  - frame-ancestors/X-Frame-Options: Travelfy laesst sich nirgends einbetten
//  - form-action/connect-src 'self': Travelfy schickt nichts an fremde Server
//  - Referrer-Policy same-origin: verlaesst man Travelfy, erfaehrt das Ziel
//    nicht, woher man kommt
//  - COOP same-origin: kein Fenster einer anderen App behaelt einen Griff
//    (window.opener) auf Travelfy und umgekehrt
//  - CORP same-origin: Bilder/Skripte von Travelfy laden nur in Travelfy
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

/* ---------------------------------------------------- Sprung-Sperre */

/** Host, unter dem Travelfy gerade angesprochen wird (hinter einem Proxy: X-Forwarded-Host). */
function ownHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/**
 * Wurde die Anfrage von einer anderen Anwendung ausgeloest? Dann liefert
 * die Funktion den Grund, sonst null.
 *
 * Moderne Browser schicken Sec-Fetch-Site mit:
 *   "same-origin" - von Travelfy selbst            -> erlaubt
 *   "none"        - Adresszeile, Lesezeichen, App  -> erlaubt
 *   "same-site"   - anderer Port/Subdomain desselben Rechners,
 *                   z.B. Kochbuch auf localhost:3000  -> gesperrt
 *   "cross-site"  - beliebige fremde Seite         -> gesperrt
 * Fehlt die Kopfzeile (alte Browser), entscheiden Origin und Referer.
 */
function foreignOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) {
    return site === "same-origin" || site === "none" ? null : `Sec-Fetch-Site: ${site}`;
  }
  const host = ownHost(req);
  const origin = req.headers.origin;
  if (origin && origin !== "null" && hostOf(origin) !== host) return `Origin: ${origin}`;
  if (origin === "null") return "Origin: null";
  const referer = req.headers.referer;
  if (referer && hostOf(referer) !== host) return `Referer: ${referer}`;
  return null;
}

function rejectForeign(req, res, pathname, reason) {
  console.warn(`Sprung-Sperre: ${req.method} ${pathname} abgewiesen (${reason})`);
  if (pathname.startsWith("/api/")) {
    const body = JSON.stringify({ error: "Anfrage aus einer anderen Anwendung abgelehnt." });
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  // Bewusst ohne Link: auch nicht zu Travelfy selbst - sonst waere der
  // Wechsel nur einen Klick weiter doch moeglich.
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    "<!DOCTYPE html><html lang=de><meta charset=utf-8><title>Travelfy – Wechsel gesperrt</title>" +
    "<body><h1>Wechsel gesperrt</h1>" +
    "<p>Travelfy lässt sich nicht aus einer anderen Anwendung heraus öffnen.</p>" +
    "<p>Bitte Travelfy direkt über die Adresszeile, ein Lesezeichen oder die installierte App starten.</p>" +
    "</body></html>"
  );
}

/* ------------------------------------------------- statische Dateien */

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = null; }
  if (decoded === null) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  const relative = decoded === "/" ? INDEX : decoded.slice(1);
  const filePath = path.join(PUBLIC_DIR, path.normalize(relative));

  // Nichts ausserhalb von public/ ausliefern (".." im Pfad).
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><meta charset=utf-8><h1>404 &ndash; nicht gefunden</h1><p>${escapeHtml(pathname)}</p>`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ------------------------------------------------------------ Server */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname;
  try {
    pathname = new URL(req.url, "http://internal").pathname;
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  res.on("finish", () => {
    console.log(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  const reason = foreignOrigin(req);
  if (reason) {
    rejectForeign(req, res, pathname, reason);
    return;
  }

  try {
    const handledByApi = await api.handle(req, res, pathname);
    if (!handledByApi) await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`Unbehandelter Fehler bei ${req.method} ${pathname}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Interner Serverfehler");
    } else {
      res.destroy();
    }
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} ist belegt. Starte z.B. mit: node server.js 3002`);
    process.exit(1);
  }
  throw err;
});

/* -------------------------------------------------------- Hochfahren */

const dbExisted = fs.existsSync(DB_FILE);
let generatedAdminPassword = null;

try {
  ({ generatedAdminPassword } = db.open(DB_FILE, { adminPassword: process.env.TRAVELFY_ADMIN_PASSWORD }));
} catch (err) {
  console.error("Datenbank konnte nicht geoeffnet werden:", err.message);
  process.exit(1);
}

server.listen(PORT, () => {
  const stats = db.getStats();
  console.log(`Travelfy laeuft auf http://localhost:${PORT}/`);
  console.log(`Datenbank: ${DB_FILE}`);
  console.log(
    `Bestand:   ${stats.trips} Reisen, ${stats.stations} Stationen, ${stats.images} Bilder ` +
    `(${(stats.imageBytes / 1024 / 1024).toFixed(2)} MB)`
  );
  console.log(`Benutzer:  ${stats.accounts} (inkl. admin)`);
  if (!dbExisted) console.log("Hinweis:   Datenbank wurde neu angelegt.");
  if (generatedAdminPassword && !process.env.TRAVELFY_ADMIN_PASSWORD) {
    console.log(`Hinweis:   Admin angelegt - Benutzer "${db.ADMIN_USERNAME}", Startpasswort: ${generatedAdminPassword}`);
    console.log("           Bitte nach der ersten Anmeldung unter \"Passwort ändern\" ändern.");
  }
  console.log("Beenden mit Strg+C");
});

/* ------------------------------------------------------ Herunterfahren */

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} empfangen - fahre herunter...`);
  server.close(() => {
    db.close();
    console.log("Datenbank geschlossen. Tschuess.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
