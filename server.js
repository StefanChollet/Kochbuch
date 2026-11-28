"use strict";

/*
  Webserver fuer das Kochbuch-Projekt.

  Das Kochbuch laeuft unter einem Unterpfad (Standard /kochbuch) - auf trex
  hinter dem Verteiler: https://chollet.corvent.ch/kochbuch/

  Aufgaben:
    1. Sprung-Sperre: Anfragen anderer Anwendungen werden abgewiesen
    2. /kochbuch/api/...  -> REST-API (siehe api.js), Daten in SQLite (db.js)
    3. /kochbuch/...      -> statische Dateien aus ./public

  Nur Node.js-Standardmodule, keine Abhaengigkeiten, kein npm install.

  Start:  node server.js          (Port 3000, http://localhost:3000/kochbuch/)
          node server.js 8080     (anderer Port)
  Umgebung:
          KOCHBUCH_DB=pfad.sqlite      Datenbankdatei
          KOCHBUCH_BASE=/kochbuch      Unterpfad ("" = ohne Unterpfad)
          KOCHBUCH_HOST=127.0.0.1      Netzwerkadresse (Standard: alle; auf
                                       trex 127.0.0.1 = nur ueber nginx)
          KOCHBUCH_ADMIN_PASSWORD=...  Startpasswort des Admins, nur beim
                                       allerersten Start (sonst zufaellig,
                                       steht dann einmalig im Log)
*/

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const db = require("./db");
const api = require("./api");

/* ------------------------------------------------------- Versionsnummer
   Beim Einspielen schreibt deploy/einspielen.sh (Verteiler) die Datei
   version.json neben server.js - aus Git: "1.<Anzahl Commits>", Kurz-Hash
   und Datum des Commits. Lokal ohne diese Datei: direkt aus dem Git-
   Repository; mit ungespeicherten Aenderungen "+dev" (und neuer Kennung bei
   jedem Start). Jede Aenderung = neuer Commit = neue Nummer. */
const VERSION = loadVersion();

function loadVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8"));
    if (v && v.version && v.commit) return { ...v, build: v.commit };
  } catch { /* keine version.json - lokal */ }
  try {
    const git = (...args) => require("node:child_process")
      .execFileSync("git", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const count = git("rev-list", "--count", "HEAD");
    const commit = git("rev-parse", "--short", "HEAD");
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
    return {
      version: `1.${count}${dirty ? "+dev" : ""}`,
      commit,
      date: dirty ? new Date().toISOString() : git("log", "-1", "--format=%cI"),
      build: dirty ? `${commit}-${Date.now().toString(36)}` : commit,
    };
  } catch { /* kein Git */ }
  return { version: "dev", commit: "", date: new Date().toISOString(), build: `dev-${Date.now().toString(36)}` };
}

/** Versionsangaben fuer Seite und /api/health. */
function versionInfo() {
  return { version: VERSION.version, commit: VERSION.commit, date: VERSION.date, build: VERSION.build };
}

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3000;
const DB_FILE = process.env.KOCHBUCH_DB
  ? path.resolve(process.env.KOCHBUCH_DB)
  : path.join(__dirname, "kochbuch.sqlite");
const INDEX = "kochbuch.html";
const HOST = process.env.KOCHBUCH_HOST || undefined;   // undefined = alle Schnittstellen
// Unterpfad ohne Schraegstrich am Ende: "/kochbuch" (oder "" fuer die Wurzel).
const BASE = normalizeBase(process.env.KOCHBUCH_BASE ?? "/kochbuch");

function normalizeBase(value) {
  const trimmed = String(value).trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(trimmed)) {
    console.error(`Ungueltiger Unterpfad KOCHBUCH_BASE="${value}" - erwartet z.B. /kochbuch`);
    process.exit(1);
  }
  return trimmed;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* ---------------------------------------------------- Sprung-Sperre */

// Abschottung gegen andere Anwendungen (z.B. Travelfy auf localhost:3001):
//  - frame-ancestors/X-Frame-Options: das Kochbuch laesst sich nirgends einbetten
//  - Referrer-Policy same-origin: verlaesst man das Kochbuch, erfaehrt das Ziel
//    nicht, woher man kommt
//  - COOP same-origin: kein Fenster einer anderen App behaelt einen Griff
//    (window.opener) auf das Kochbuch und umgekehrt
//  - CORP same-origin: Bilder/Skripte des Kochbuchs laden nur im Kochbuch
const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

/** Host, unter dem das Kochbuch gerade angesprochen wird (hinter nginx: X-Forwarded-Host). */
function ownHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/** Pfad einer URL, wenn sie auf den eigenen Host zeigt - sonst null. */
function ownPathOf(url, host) {
  try {
    const u = new URL(url);
    return u.host.toLowerCase() === host ? u.pathname : null;
  } catch {
    return null;
  }
}

/** Seite des Kochbuchs selbst? (Ohne Unterpfad gehoert der ganze Host dem Kochbuch.) */
function isOwnPath(p) {
  return p !== null && (BASE === "" || p === BASE || p.startsWith(BASE + "/"));
}

/** Die Startseite des Verteilers (https://chollet.corvent.ch/). */
function isVerteilerPath(p) {
  return BASE !== "" && (p === "/" || p === "/index.html");
}

/**
 * Wurde die Anfrage von einer anderen Anwendung ausgeloest? Dann liefert
 * die Funktion den Grund, sonst null.
 *
 * Auf trex teilen sich alle Apps einen Host (chollet.corvent.ch/<app>/).
 * Fuer den Browser ist das EINE Herkunft - deshalb zaehlt hier der Pfad
 * der ausloesenden Seite (Referer), nicht nur der Host:
 *   Sec-Fetch-Site "none"         Adresszeile, Lesezeichen, App -> erlaubt
 *   "same-site" / "cross-site"    anderer Host/Port             -> gesperrt
 *   gleicher Host, Referer ...
 *     /kochbuch/...               das Kochbuch selbst           -> erlaubt
 *     /  (Verteiler-Startseite)   nur Seitenaufruf (Kachel)     -> erlaubt
 *     /travelfy/... o.ae.         andere App                    -> gesperrt
 * Alte Browser ohne Sec-Fetch-Site: dieselbe Pruefung ueber Origin/Referer.
 */
function foreignOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site === "none") return null;
  if (site && site !== "same-origin") return `Sec-Fetch-Site: ${site}`;

  const host = ownHost(req);
  const origin = req.headers.origin;
  if (origin === "null") return "Origin: null";
  if (origin && hostOf(origin) !== host) return `Origin: ${origin}`;

  const navigate = req.headers["sec-fetch-mode"] === "navigate";
  const referer = req.headers.referer;
  if (referer) {
    const from = ownPathOf(referer, host);
    if (isOwnPath(from)) return null;
    if (isVerteilerPath(from) && (navigate || !site)) return null;
    return `Referer: ${referer}`;
  }
  // Ohne Referer (Neuladen mit F5, Service-Worker-Aktualisierung): erlaubt.
  // Keine der Apps erzeugt Links ohne Referer (rel=noreferrer).
  return null;
}

function rejectForeign(req, res, pathname, reason) {
  console.warn(`Sprung-Sperre: ${req.method} ${pathname} abgewiesen (${reason})`);
  if (pathname.startsWith(`${BASE}/api/`)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Anfrage aus einer anderen Anwendung abgelehnt." }));
    return;
  }
  // Bewusst ohne Link: auch nicht zum Kochbuch selbst - sonst waere der
  // Wechsel nur einen Klick weiter doch moeglich.
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    "<!DOCTYPE html><html lang=de><meta charset=utf-8><title>Kochbuch – Wechsel gesperrt</title>" +
    "<body><h1>Wechsel gesperrt</h1>" +
    "<p>Das Kochbuch lässt sich nicht aus einer anderen Anwendung heraus öffnen.</p>" +
    "<p>Bitte das Kochbuch direkt über die Adresszeile, ein Lesezeichen oder die installierte App starten.</p>" +
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

  const relative = pathname === "/" ? INDEX : pathname.slice(1);
  // Versionsnummer als Skript (fuer die Anzeige unten links) und der Service
  // Worker mit der Version im Cache-Namen - so erneuert sich die App-Huelle
  // bei jeder neuen Version von selbst.
  if (relative === "version.js" || relative === "sw.js") {
    let body;
    if (relative === "version.js") {
      body = `self.APP_VERSION = ${JSON.stringify(versionInfo())};\n`;
    } else {
      try { body = (await fsp.readFile(path.join(PUBLIC_DIR, "sw.js"), "utf8")).replace(/__BUILD__/g, VERSION.build); }
      catch { body = null; }
    }
    if (body !== null) {
      const buf = Buffer.from(body, "utf8");
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : buf);
      return;
    }
  }
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
    res.end(`<h1>404 &ndash; nicht gefunden</h1><p>${escapeHtml(pathname)}</p>`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": data.length,
    // Waehrend der Entwicklung nichts cachen, damit Aenderungen sofort greifen.
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
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
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

  // Unterpfad: /kochbuch -> /kochbuch/ ; "/" und alte Kochansicht-Links von
  // vor dem Umzug (/kochansicht.html?code=...) auf die neue Adresse umleiten.
  if (BASE && (pathname === BASE || pathname === "/" || pathname === "/kochansicht.html")) {
    const query = new URL(req.url, "http://internal").search;
    const target = pathname === "/kochansicht.html" ? `${BASE}/kochansicht.html${query}` : `${BASE}/`;
    res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (BASE && !pathname.startsWith(BASE + "/")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Nicht gefunden");
    return;
  }
  const appPath = pathname.slice(BASE.length);

  try {
    // Versionsnummer: oeffentlich und nie zwischengespeichert - die Anzeige unten
    // links vergleicht damit, ob die offene Seite noch die aktuelle Version ist.
    if (appPath === "/api/version" && req.method === "GET") {
      const buf = Buffer.from(JSON.stringify(versionInfo()), "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(buf);
      return;
    }
    const handledByApi = await api.handle(req, res, appPath);
    if (!handledByApi) await serveStatic(req, res, appPath);
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
    console.error(`Port ${PORT} ist belegt. Starte z.B. mit: node server.js 3001`);
    process.exit(1);
  }
  throw err;
});

/* -------------------------------------------------------- Hochfahren */

// Vor dem Oeffnen pruefen - db.open() legt die Datei sonst selbst an.
const dbExisted = fs.existsSync(DB_FILE);
let generatedAdminPassword = null;

try {
  ({ generatedAdminPassword } = db.open(DB_FILE, { adminPassword: process.env.KOCHBUCH_ADMIN_PASSWORD }));
} catch (err) {
  console.error("Datenbank konnte nicht geoeffnet werden:", err.message);
  process.exit(1);
}

api.configure({ base: BASE });

server.listen(PORT, HOST, () => {
  const stats = db.getStats();
  console.log(`Kochbuch laeuft auf http://${HOST && HOST !== "127.0.0.1" ? HOST : "localhost"}:${PORT}${BASE}/`);
  console.log(`Datenbank: ${DB_FILE}`);
  console.log(
    `Bestand:   ${stats.recipes} Rezepte, ${stats.images} Bilder ` +
    `(${(stats.imageBytes / 1024 / 1024).toFixed(2)} MB), ${stats.fridgeItems} Kuehlschrank-Eintraege`
  );
  console.log(`Benutzer:  ${stats.accounts} (inkl. admin)`);
  if (!dbExisted) console.log("Hinweis:   Datenbank wurde neu angelegt.");
  if (generatedAdminPassword && !process.env.KOCHBUCH_ADMIN_PASSWORD) {
    console.log(`Hinweis:   Admin angelegt - Benutzer "${db.ADMIN_USERNAME}", Startpasswort: ${generatedAdminPassword}`);
    console.log("           Bitte nach der ersten Anmeldung unter \"Passwort\" ändern.");
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
    // Schliesst die Datenbank sauber und schreibt das WAL zurueck.
    db.close();
    console.log("Datenbank geschlossen. Tschuess.");
    process.exit(0);
  });
  // Falls noch Verbindungen haengen, nicht ewig warten.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
