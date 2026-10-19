"use strict";

/* =========================================================================
   Kochansicht — zeigt genau ein Rezept zum Nachkochen, nur lesend.
   Zugang: angemeldet im Kochbuch (Sitzungs-Cookie) UND gueltiger Code in
   der URL (?code=...). Die Seite kann nichts aendern; der Server liefert
   ueber /api/views/:code ausschliesslich dieses eine Rezept.
   ========================================================================= */

const CODE_PATTERN = /^[A-Za-z0-9]{24,30}$/;

const viewMessage = document.getElementById("viewMessage");
const viewMain = document.getElementById("viewMain");
const viewTools = document.getElementById("viewTools");

// Theme wie im Kochbuch (gleiche Einstellung im Browser).
(function initTheme(){
  let saved = null;
  try{ saved = window.localStorage.getItem("kochbuch_theme"); }catch{ /* ohne Speicher: Systemeinstellung */ }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", saved || (prefersDark ? "dark" : "light"));
})();

function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function showMessage(html, kind = "error"){
  viewMessage.innerHTML = html;
  viewMessage.dataset.kind = kind;
  viewMessage.hidden = false;
  viewMain.hidden = true;
  viewTools.hidden = true;
}

async function getJson(path){
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, payload };
}

/** Zubereitungstext in Schritte: eine Zeile = ein Schritt, vorhandene "1." / "-" weg. */
function splitSteps(text){
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^(\d+[.)]|[-*•])\s+/, ""))
    .filter(Boolean);
}

// Kennzeichnung je Zutat (Abgleich macht der Server, siehe db.withFridgeMatch).
const FRIDGE_BADGES = {
  da: ' <span class="fridge-badge fridge-badge-da" title="Im Kühlschrank vorhanden">im Kühlschrank</span>',
  vorrat: ' <span class="fridge-badge" title="Gilt als Vorrat, den man meist im Haus hat">Vorrat</span>',
  fehlt: ' <span class="fridge-badge fridge-badge-fehlt" title="Nicht im Kühlschrank">fehlt</span>',
};

/** Kuehlschrank nur lesend; Eintraege, die das Rezept braucht, stehen oben und sind markiert. */
function renderFridge(recipe){
  const fridge = (recipe.fridge || []).slice()
    .sort((a, b) => (b.usedBy.length > 0) - (a.usedBy.length > 0));
  document.getElementById("viewFridgeList").innerHTML = fridge.map(f => `
    <li class="${f.usedBy.length ? "is-used" : ""}" title="${f.usedBy.length ? `Für: ${escapeHtml(f.usedBy.join(", "))}` : "Für dieses Rezept nicht gebraucht"}">
      <span>${f.usedBy.length ? "✓ " : ""}${escapeHtml(f.name)}</span>
      <span class="amount">${escapeHtml(f.amount || "")}</span>
    </li>`).join("");
  document.getElementById("viewFridgeEmpty").hidden = fridge.length > 0;

  const ingredients = recipe.ingredients || [];
  const missing = ingredients.filter(i => i.fridge === "fehlt").length;
  const summary = document.getElementById("viewFridgeSummary");
  summary.textContent = missing === 0
    ? "Alles da – es kann losgehen."
    : `${ingredients.length - missing} von ${ingredients.length} Zutaten da, ${missing} fehlen.`;
  summary.dataset.kind = missing === 0 ? "success" : "info";
  summary.hidden = ingredients.length === 0;
}

function render(recipe){
  currentRecipeId = recipe.id;
  document.title = `${recipe.name} – Kochansicht`;
  document.getElementById("viewTitle").textContent = recipe.name;

  const category = document.getElementById("viewCategory");
  category.textContent = recipe.category || "";
  category.hidden = !recipe.category;

  const short = document.getElementById("viewShort");
  short.textContent = recipe.shortDesc || "";
  short.hidden = !recipe.shortDesc;

  const updated = recipe.updatedAt ? new Date(recipe.updatedAt).toLocaleDateString("de-CH") : "";
  document.getElementById("viewMeta").textContent =
    [recipe.createdByName && `Von ${recipe.createdByName}`, updated && `Stand ${updated}`].filter(Boolean).join(" · ");

  const images = document.getElementById("viewImages");
  images.innerHTML = (recipe.images || [])
    .map(img => `<img src="${img.url}" alt="${escapeHtml(img.name)}" loading="lazy">`).join("");
  images.hidden = !(recipe.images || []).length;

  const ingredients = recipe.ingredients || [];
  document.getElementById("viewIngredientList").innerHTML = ingredients.map(ing => `
    <li class="fridge-${ing.fridge || "fehlt"}"><label>
      <input type="checkbox">
      <span>${escapeHtml(ing.name)}${FRIDGE_BADGES[ing.fridge] || ""}</span>
      <span class="amount">${escapeHtml(ing.amount || "")}</span>
    </label></li>`).join("");
  document.getElementById("viewNoIngredients").hidden = ingredients.length > 0;
  renderFridge(recipe);

  const steps = splitSteps(recipe.longText);
  document.getElementById("viewStepList").innerHTML = steps.map(s => `<li>${escapeHtml(s)}</li>`).join("");
  document.getElementById("viewNoSteps").hidden = steps.length > 0;

  viewMessage.hidden = true;
  viewMain.hidden = false;
  viewTools.hidden = false;
}

/* ---- Bildschirm anlassen (Screen Wake Lock, wo der Browser es kann) ---- */
const wakeLockToggle = document.getElementById("wakeLockToggle");
let wakeLock = null;

async function setWakeLock(on){
  try{
    if(on){
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }else if(wakeLock){
      await wakeLock.release();
    }
  }catch{
    wakeLockToggle.checked = false;
  }
}

if(!("wakeLock" in navigator)){
  wakeLockToggle.closest("label").hidden = true;
}
wakeLockToggle.addEventListener("change", () => setWakeLock(wakeLockToggle.checked));
// Der Browser gibt die Sperre beim Tab-Wechsel frei - beim Zurueckkommen erneuern.
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible" && wakeLockToggle.checked && !wakeLock) setWakeLock(true);
});

document.getElementById("printBtn").addEventListener("click", () => window.print());

/* ---- Zurueck zum Rezept ----
   Vom Rezeptdialog aus geoeffnet ist die Ansicht ein eigener Tab: den
   schliessen, dahinter ist das Rezept im Kochbuch noch offen. Laesst der
   Browser das Schliessen nicht zu (Ansicht per Link/Lesezeichen geoeffnet),
   stattdessen das Kochbuch mit genau diesem Rezept im Detaildialog laden. */
let currentRecipeId = null;

document.getElementById("backBtn").addEventListener("click", () => {
  const fallback = currentRecipeId ? `/?recipe=${encodeURIComponent(currentRecipeId)}` : "/";
  window.close();
  // Ist der Tab noch da, hat der Browser das Schliessen verweigert.
  setTimeout(() => { if(!window.closed) window.location.replace(fallback); }, 150);
});

// PWA: derselbe Service Worker wie im Kochbuch (speichert nur die Huelle, nie den Code oder Daten).
if("serviceWorker" in navigator){
  navigator.serviceWorker.register("/sw.js").catch(() => { /* ohne SW laeuft die Seite genauso */ });
}

/* ---- Start ---- */
(async function init(){
  const code = new URLSearchParams(window.location.search).get("code") || "";
  if(!CODE_PATTERN.test(code)){
    showMessage("Ungültiger Link. Die Kochansicht öffnest du im Kochbuch über das Rezept.");
    return;
  }
  try{
    const status = await getJson("/api/auth/status");
    if(!status.payload.user){
      // Nach der Anmeldung kommt das Kochbuch direkt hierher zurueck.
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      showMessage(`Bitte zuerst <a href="/?next=${next}">im Kochbuch anmelden</a> – danach geht es hier weiter.`, "info");
      return;
    }
    const view = await getJson(`/api/views/${encodeURIComponent(code)}`);
    if(!view.ok){
      showMessage(escapeHtml(view.payload.error || `Fehler (HTTP ${view.status}).`));
      return;
    }
    render(view.payload);
  }catch{
    showMessage("Server nicht erreichbar.");
  }
})();
