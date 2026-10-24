"use strict";

/* =========================================================================
   Aufraeum-Service-Worker: Die App-Installation (PWA) ist wieder entfernt.
   Geraete, die den alten Service Worker noch haben, holen beim naechsten
   Besuch diese Fassung - sie loescht alle Caches und meldet sich ab.
   Kann entfernt werden, sobald alle Geraete das Kochbuch einmal geoeffnet haben.
   ========================================================================= */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
  })());
});
