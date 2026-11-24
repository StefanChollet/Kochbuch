"use strict";

/* Verteiler-Startseite: baut die Kacheln aus apps.json.
   Eine neue App = ein Eintrag in apps.json (siehe README). */

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

(async function init(){
  const list = document.getElementById("apps");
  let config;
  try{
    const res = await fetch("apps.json", { cache: "no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  }catch(err){
    list.innerHTML = `<li class="fehler">Die Liste der Anwendungen konnte nicht geladen werden (${escapeHtml(err.message)}).</li>`;
    return;
  }

  if(config.titel){
    document.getElementById("titel").textContent = config.titel;
    document.title = config.titel;
  }

  list.innerHTML = config.apps
    .filter(app => /^[a-z0-9-]+$/.test(app.id))
    .map(app => `
      <li>
        <a class="app" href="/${app.id}/" data-farbe="${/^#[0-9a-fA-F]{6}$/.test(app.farbe) ? app.farbe : "#6A6244"}">
          ${app.icon ? `<img class="app-icon" src="${escapeHtml(app.icon)}" alt="" width="64" height="64">` : ""}
          <span class="app-text">
            <span class="app-name">${escapeHtml(app.name)}</span>
            <span class="app-desc">${escapeHtml(app.beschreibung)}</span>
            <span class="app-url">${escapeHtml(window.location.host)}/${escapeHtml(app.id)}/</span>
          </span>
        </a>
      </li>`)
    .join("");
  // Farbe je Kachel ueber das CSSOM (kein style-Attribut - die CSP verbietet Inline-Styles).
  list.querySelectorAll("a[data-farbe]").forEach(a => a.style.setProperty("--app-farbe", a.dataset.farbe));
})();
