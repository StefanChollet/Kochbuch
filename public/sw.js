"use strict";

/* =========================================================================
   Service Worker des Kochbuchs (PWA).

   Grundsatz: Nur die App-Huelle (HTML/CSS/JS/Icons) wird zwischengespeichert,
   damit die App auch bei schlechtem Netz startet. Alles unter /api - Rezepte,
   Bilder, Kuehlschrank, Anmeldung - geht IMMER direkt zum Server und wird nie
   gespeichert: private Daten gehoeren nicht in einen Geraete-Cache, und
   ein Abmelden muss sofort wirken.

   Huelle: "Netz zuerst" - jede Aenderung auf dem Server kommt sofort an;
   nur ohne Netz kommt die zuletzt gespeicherte Fassung.
   ========================================================================= */

const CACHE = "kochbuch-shell-v2";
const SHELL = [
  "/",
  "/kochbuch.css",
  "/kochbuch.js",
  "/kochansicht.html",
  "/kochansicht.css",
  "/kochansicht.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  // Alte Huellen-Versionen wegraeumen.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Cache-Schluessel ohne Query: /kochansicht.html?code=... landet als /kochansicht.html -
    der Zugangscode wird so nie im Cache abgelegt. */
function shellKey(url) {
  return url.pathname === "/kochbuch.html" ? "/" : url.pathname;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // z.B. Google Fonts: Browser regelt das
  if (url.pathname.startsWith("/api/")) return;      // private Daten: nie anfassen

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
        "<p style='font-family:sans-serif;padding:2rem'>Keine Verbindung zum Kochbuch-Server.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  })());
});
