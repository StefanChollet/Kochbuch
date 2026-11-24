"use strict";

/*
  Lokaler Nachbau des nginx-Verteilers von trex - zum Testen auf dem eigenen
  Rechner, ohne nginx. Verhalten wie deploy/chollet-apps.conf:
    /               -> Startseite aus public/
    /<app>          -> 301 auf /<app>/
    /<app>/...      -> http://127.0.0.1:<port> (Pfad unveraendert, Host bleibt)
    /kochansicht.html?... -> 302 auf /kochbuch/kochansicht.html?...
    alles andere    -> 404

  Aufruf: node tools/lokal.js [port]     (Standard 8080)
  Die Apps muessen laufen (Kochbuch: node server.js, Travelfy: node server.js).
*/

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.argv[2]) || 8080;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "apps.json"), "utf8"));
const apps = new Map(config.apps.map((a) => [a.id, a]));

const STATIC = /^\/(index\.html|verteiler\.(css|js)|apps\.json|favicon\.svg|icons\/[a-z0-9-]+\.png)$/;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://intern");
  const p = url.pathname;
  const log = (s) => console.log(`${req.method} ${p} -> ${s}`);

  if (p === "/" || STATIC.test(p)) {
    const file = path.join(PUBLIC, p === "/" ? "index.html" : p.slice(1));
    fs.readFile(file, (err, data) => {
      if (err) { log(404); return send(res, 404, {}, "404"); }
      log(200);
      send(res, 200, { ...HEADERS, "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }, data);
    });
    return;
  }
  if (p === "/kochansicht.html") {
    log(302);
    return send(res, 302, { Location: `/kochbuch/kochansicht.html${url.search}` });
  }

  const id = p.split("/")[1];
  const app = apps.get(id);
  if (app && p === `/${id}`) { log(301); return send(res, 301, { Location: `/${id}/` }); }
  if (!app || !p.startsWith(`/${id}/`)) { log(404); return send(res, 404, {}, "404"); }

  const upstream = http.request({
    host: "127.0.0.1",
    port: app.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, "x-real-ip": req.socket.remoteAddress, "x-forwarded-proto": "http" },
  }, (up) => {
    log(`${app.id}:${app.port} ${up.statusCode}`);
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { log(`502 (${app.id} laeuft nicht?)`); if (!res.headersSent) send(res, 502, { "Content-Type": "text/plain; charset=utf-8" }, `${app.name} ist nicht erreichbar (Port ${app.port}).`); });
  req.pipe(upstream);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Verteiler (lokal) auf http://localhost:${PORT}/`);
  for (const a of config.apps) console.log(`  /${a.id}/  ->  127.0.0.1:${a.port}`);
});
