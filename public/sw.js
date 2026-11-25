"use strict";

/* =========================================================================
   Service Worker von Travelfy (PWA).

   Nur die App-Huelle (HTML/CSS/JS/Icons) wird zwischengespeichert, "Netz
   zuerst". Alles unter /api - Reisen, Bilder, Anmeldung - geht IMMER direkt
   zum Server und wird nie gespeichert. Anfragen an andere Herkuenfte
   werden nicht angefasst.
   ========================================================================= */

const CACHE = "travelfy-shell-v11";
// Basis der App = Verzeichnis dieses Skripts, z.B. "/travelfy/".
const BASE = new URL("./", self.location.href).pathname;
const SHELL = [
  "",
  "login.html",
  "reise.html",
  "travelfy.css",
  "common.js",
  "travelfy.js",
  "reise.js",
  "zeichnen.js",
  "login.js",
  "manifest.webmanifest",
  "icons/favicon.svg",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
].map((p) => BASE + p);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("travelfy-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Cache-Schluessel ohne Query (reise.html?id=... -> /reise.html). */
function shellKey(url) {
  return url.pathname === BASE + "index.html" ? BASE : url.pathname;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;          // andere Apps auf diesem Host
  if (url.pathname.startsWith(BASE + "api/")) return;  // private Daten: nie anfassen

  const key = shellKey(url);
  if (!SHELL.includes(key)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(key, fresh.clone());
      return fresh;
    } catch {
      const cached = await cache.match(key);
      if (cached) return cached;
      return new Response(
        "<!DOCTYPE html><meta charset=utf-8><title>Offline</title>" +
        "<p>Keine Verbindung zum Travelfy-Server.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  })());
});
