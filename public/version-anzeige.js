"use strict";

/* =========================================================================
   Versionsnummer unten links (gleiche Datei in Kochbuch und Travelfy).

   version.js (vom Server erzeugt) liefert self.APP_VERSION - die Version,
   mit der diese Seite geladen wurde. Die Nummer kommt aus Git
   ("1.<Anzahl Commits>"), steigt also mit jeder Aenderung.

   Zusaetzlich fragt die Anzeige api/version (nie zwischengespeichert): laeuft
   auf dem Server schon eine neuere Version als die offene Seite, wird sie
   hervorgehoben und laedt die Seite auf Klick neu. Geprueft wird beim Laden,
   beim Zurueckkehren zum Tab und alle 5 Minuten.
   ========================================================================= */
(function(){
  const own = self.APP_VERSION;
  if(!own || !document.body) return;

  const el = document.createElement("button");
  el.type = "button";
  el.className = "app-version";
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);

  const fmtDate = (iso) => {
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const describe = (v) => `Version ${v.version}${v.commit ? ` (${v.commit})` : ""}${v.date ? ` vom ${fmtDate(v.date)}` : ""}`;

  let newer = null;
  function show(){
    if(newer){
      el.classList.add("is-outdated");
      el.textContent = `Version ${own.version} – neu: ${newer.version} · neu laden`;
      el.title = `Diese Seite: ${describe(own)}\nAuf dem Server: ${describe(newer)}\nKlick lädt die aktuelle Version.`;
    }else{
      el.classList.remove("is-outdated");
      el.textContent = `Version ${own.version}`;
      el.title = `${describe(own)} – aktuell`;
    }
  }

  async function check(){
    try{
      const res = await fetch("api/version", { cache: "no-store", credentials: "same-origin" });
      if(!res.ok) return;
      const server = await res.json();
      newer = server && server.build && server.build !== own.build ? server : null;
      show();
    }catch{ /* offline - Anzeige bleibt */ }
  }

  el.addEventListener("click", async () => {
    if(!newer){ check(); return; }
    el.disabled = true;
    el.textContent = "Lädt neu…";
    // Service Worker zuerst erneuern, dann die Seite neu laden
    try{
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if(reg) await reg.update();
    }catch{ /* egal */ }
    window.location.reload();
  });

  show();
  check();
  document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") check(); });
  setInterval(check, 5 * 60 * 1000);
})();
