"use strict";

/*
  Webserver fuer das Kochbuch-Projekt.

  Zwei Aufgaben:
    1. /api/...  -> REST-API (siehe api.js), Daten liegen in SQLite (siehe db.js)
    2. alles andere -> statische Dateien aus ./public

  Nur Node.js-Standardmodule, keine Abhaengigkeiten, kein npm install.

  Start:  node server.js          (Port 3000)
          node server.js 8080     (anderer Port)
  Umgebung:
          KOCHBUCH_DB=pfad.sqlite node server.js
*/

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const db = require("./db");
const api = require("./api");

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3000;
const DB_FILE = process.env.KOCHBUCH_DB
  ? path.resolve(process.env.KOCHBUCH_DB)
  : path.join(__dirname, "kochbuch.sqlite");
const INDEX = "kochbuchV2.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

/* ------------------------------------------------- statische Dateien */

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const relative = pathname === "/" ? INDEX : pathname.slice(1);
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
    console.error(`Port ${PORT} ist belegt. Starte z.B. mit: node server.js 3001`);
    process.exit(1);
  }
  throw err;
});

/* -------------------------------------------------------- Hochfahren */

// Vor dem Oeffnen pruefen - db.open() legt die Datei sonst selbst an.
const dbExisted = fs.existsSync(DB_FILE);

try {
  db.open(DB_FILE);
} catch (err) {
  console.error("Datenbank konnte nicht geoeffnet werden:", err.message);
  process.exit(1);
}

server.listen(PORT, () => {
  const stats = db.getStats();
  console.log(`Kochbuch laeuft auf http://localhost:${PORT}/`);
  console.log(`Datenbank: ${DB_FILE}`);
  console.log(
    `Bestand:   ${stats.recipes} Rezepte, ${stats.images} Bilder ` +
    `(${(stats.imageBytes / 1024 / 1024).toFixed(2)} MB), ${stats.fridgeItems} Kuehlschrank-Eintraege`
  );
  if (!dbExisted) console.log("Hinweis:   Datenbank wurde neu angelegt.");
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
