"use strict";

/* =========================================================================
   API — Zugriff auf den Server (REST, JSON).
   Netzwerk- und HTTP-Fehler kommen einheitlich als Error mit lesbarem Text.
   ========================================================================= */
const API = {
  base: "/api",

  async request(method, path, body){
    let res;
    try{
      res = await fetch(this.base + path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }catch(err){
      throw new Error("Server nicht erreichbar. Läuft \"node server.js\" noch?");
    }

    if(res.status === 204) return null;

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const payload = isJson ? await res.json() : await res.text();

    // Sitzung abgelaufen oder abgemeldet: zurueck zur Anmeldung. Login und
    // Passwortwechsel melden falsche Passwoerter selbst (eigener Fehlertext).
    if(res.status === 401 && !path.startsWith("/auth/")){
      showAuthScreen(false);
    }

    if(!res.ok){
      throw new Error((payload && payload.error) || `Serverfehler (HTTP ${res.status}).`);
    }
    return payload;
  },

  get(path){ return this.request("GET", path); },
  post(path, body){ return this.request("POST", path, body ?? {}); },
  put(path, body){ return this.request("PUT", path, body); },
  patch(path, body){ return this.request("PATCH", path, body); },
  del(path){ return this.request("DELETE", path); }
};

const enc = encodeURIComponent;

/* =========================================================================
   DB — Datenschicht der App.
   Haelt den zuletzt vom Server geladenen Stand in DB.data und schreibt jede
   Aenderung sofort ueber die API in die SQLite-Datenbank.
   ========================================================================= */
const DB = {
  data: { fridge: [], ingredientCatalog: [], categoryOptions: [] },
  // Aktuell angezeigte Seite der Rezeptuebersicht (Suche/Sortierung/Paging
  // laufen serverseitig in SQL - siehe refreshRecipes()).
  recipesPage: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 },

  async load(){
    this.data = await API.get("/state");
    return this.data;
  },

  // ---- Rezepte ----
  // Die Uebersicht enthaelt nur Kopfdaten; Zutaten und Bilder kommen erst
  // beim Oeffnen eines Rezepts dazu.
  async getRecipe(id){
    return API.get(`/recipes/${enc(id)}`);
  },
  async saveRecipe(recipe){
    const saved = recipe.id
      ? await API.put(`/recipes/${enc(recipe.id)}`, recipe)
      : await API.post("/recipes", recipe);
    await this.refreshCatalog();
    return saved;
  },
  async deleteRecipe(id){
    await API.del(`/recipes/${enc(id)}`);
  },
  // Empfehlungen: Kuehlschrank + aktueller Suchfilter; exclude = zuletzt
  // gezeigte Rezepte, damit ein erneuter Klick eine andere Auswahl liefert.
  async getRecommendations(search, exclude){
    const params = new URLSearchParams({ limit: "4" });
    if(search) params.set("search", search);
    if(exclude.length) params.set("exclude", exclude.join(","));
    return API.get(`/recommendations?${params.toString()}`);
  },
  async refreshRecipes(query){
    const params = new URLSearchParams();
    if(query.search) params.set("search", query.search);
    if(query.scope && query.scope !== "all") params.set("scope", query.scope);
    params.set("sortBy", query.sortBy || "name");
    params.set("sortDir", query.sortDir || "asc");
    params.set("page", String(query.page || 1));
    params.set("pageSize", String(query.pageSize || 20));
    this.recipesPage = await API.get(`/recipes?${params.toString()}`);
    return this.recipesPage;
  },

  // ---- Zutaten-Katalog ----
  async addToIngredientCatalog(name){
    const clean = name.trim();
    if(!clean) return;
    const exists = this.data.ingredientCatalog.some(n => n.toLowerCase() === clean.toLowerCase());
    if(exists) return;
    await API.post("/catalog", { name: clean });
    await this.refreshCatalog();
  },
  async refreshCatalog(){
    this.data.ingredientCatalog = await API.get("/catalog");
  },

  // ---- Kuehlschrank ----
  async addFridgeItem(item){
    const created = await API.post("/fridge", item);
    this.data.fridge.push(created);
    return created;
  },
  async updateFridgeItem(id, changes){
    const updated = await API.patch(`/fridge/${enc(id)}`, changes);
    const idx = this.data.fridge.findIndex(f => f.id === id);
    if(idx !== -1) this.data.fridge[idx] = updated;
    return updated;
  },
  async deleteFridgeItem(id){
    await API.del(`/fridge/${enc(id)}`);
    this.data.fridge = this.data.fridge.filter(f => f.id !== id);
  },
  async clearFridge(){
    await API.del("/fridge");
    this.data.fridge = [];
  }
};

function makeId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function truncate(str, max){
  if(!str) return "";
  if(str.length <= max) return escapeHtml(str);
  return escapeHtml(str.slice(0, max - 1).trimEnd()) + "…";
}

/* =========================================================================
   Statusmeldungen — eine Zeile unter dem Header.
   ========================================================================= */
const statusBar = document.getElementById("appStatus");
let statusTimer = null;

/**
 * Ein offener modaler Dialog verdeckt die Statuszeile - darum erscheint die
 * Meldung zusaetzlich in seiner eigenen Zeile (.dialog-status), falls er eine hat.
 */
function statusTargets(){
  const inDialog = document.querySelector("dialog[open] .dialog-status");
  return inDialog ? [statusBar, inDialog] : [statusBar];
}

function showStatus(message, kind = "info"){
  clearTimeout(statusTimer);
  const targets = statusTargets();
  for(const el of targets){
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
  }
  if(kind !== "error"){
    statusTimer = setTimeout(() => targets.forEach(el => { el.hidden = true; }), 3000);
  }
}

function clearStatus(){
  clearTimeout(statusTimer);
  statusBar.hidden = true;
  document.querySelectorAll(".dialog-status").forEach(el => { el.hidden = true; });
}

/**
 * Fuehrt eine Server-Aktion aus und zeigt Fehler an, statt sie zu verschlucken.
 * Gibt true zurueck, wenn alles geklappt hat.
 */
async function guard(action, { success } = {}){
  try{
    await action();
    if(success) showStatus(success, "success");
    return true;
  }catch(err){
    console.error("Kochbuch:", err);
    showStatus(err.message, "error");
    return false;
  }
}

/* =========================================================================
   Theme — bleibt bewusst im Browser: eine Anzeigeeinstellung pro Geraet,
   kein Inhalt, der auf den Server gehoert.
   ========================================================================= */
const themeToggleBtn = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.textContent = theme === "dark" ? "☀️" : "🌙";
  window.localStorage.setItem("kochbuch_theme", theme);
}

(function initTheme(){
  const saved = window.localStorage.getItem("kochbuch_theme") || window.localStorage.getItem("kochbuchV2_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
})();

themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

/* =========================================================================
   Empfehlungen — entstehen erst per Klick auf "Neue Empfehlungen" aus
   Kuehlschrank-Bestand und aktuellem Suchfilter (Algorithmus: db.js,
   getRecommendations). Jeder weitere Klick zieht eine neue Auswahl.
   ========================================================================= */
const newRecommendationsBtn = document.getElementById("newRecommendationsBtn");
const recommendationsSub = document.getElementById("recommendationsSub");
const recommendationsRow = document.getElementById("recommendationsRow");
let lastRecommendationIds = [];

function renderRecommendations(data){
  const { items, basedOnFridge, fridgeItems, candidates, search } = data;
  lastRecommendationIds = items.map(r => r.id);

  const filterText = search ? ` und Suchfilter „${search}"` : "";
  if(items.length === 0){
    recommendationsSub.textContent = search
      ? `Keine Rezepte für den Suchfilter „${search}" – Suche ändern oder zurücksetzen.`
      : "Keine Rezepte vorhanden.";
    recommendationsRow.innerHTML = "";
    return;
  }
  recommendationsSub.textContent = basedOnFridge
    ? `Passend zu ${fridgeItems} Kühlschrank-Einträgen${filterText} – ${candidates} Rezepte geprüft.`
    : (fridgeItems === 0
        ? `Der Kühlschrank ist leer – zufällige Auswahl${filterText} zum Entdecken.`
        : `Kein Rezept${search ? " im Filter" : ""} nutzt deinen Kühlschrank – zufällige Auswahl${filterText}.`);

  recommendationsRow.innerHTML = items.map(r => `
    <button type="button" class="recommendation-card" data-id="${r.id}">
      ${r.thumbnailUrl
        ? `<img class="recommendation-thumb" src="${r.thumbnailUrl}" alt="" loading="lazy">`
        : `<div class="recommendation-thumb recommendation-thumb-placeholder" aria-hidden="true">🍽️</div>`}
      <span class="recommendation-name">${escapeHtml(r.name)}</span>
      ${r.ownerName ? `<span class="recommendation-owner">von ${escapeHtml(r.ownerName)}</span>` : ""}
      <span class="recommendation-desc">${truncate(r.shortDesc, 70)}</span>
      ${r.reason === "fridge"
        ? `<span class="recommendation-badge">${r.matchCount}/${r.totalIngredients} Zutaten im Kühlschrank</span>
           <span class="recommendation-detail recommendation-have"><strong>Da:</strong> ${escapeHtml(r.matched.join(", "))}</span>
           ${r.missing.length ? `<span class="recommendation-detail recommendation-missing"><strong>Fehlt:</strong> ${escapeHtml(r.missing.join(", "))}</span>` : ""}`
        : `<span class="recommendation-badge recommendation-badge-filler">Zufallsvorschlag</span>`}
    </button>
  `).join("");
}

newRecommendationsBtn.addEventListener("click", async () => {
  newRecommendationsBtn.disabled = true;
  await guard(async () => {
    // Suchtext direkt aus dem Feld: der Filter gilt so, wie er gerade sichtbar ist.
    const search = recipeSearchInput.value.trim();
    renderRecommendations(await DB.getRecommendations(search, lastRecommendationIds));
  });
  newRecommendationsBtn.disabled = false;
});

recommendationsRow.addEventListener("click", async (e) => {
  const card = e.target.closest(".recommendation-card");
  if(!card) return;
  await guard(async () => {
    openRecipeDialog(await DB.getRecipe(card.dataset.id));
  });
});

/* =========================================================================
   Rezept-Uebersicht (Tabelle) — mit Suche, Sortierung und Paging.
   Suche/Sortierung/Paging laufen serverseitig; recipeQuery haelt den
   aktuell angezeigten Zustand, loadRecipes() holt dazu die passende Seite.
   ========================================================================= */
const recipeTableBody = document.getElementById("recipeTableBody");
const recipeEmptyState = document.getElementById("recipeEmptyState");
const recipeSearchInput = document.getElementById("recipeSearchInput");
const recipeSortSelect = document.getElementById("recipeSortSelect");
const recipePageSizeSelect = document.getElementById("recipePageSizeSelect");
const recipePagerInfo = document.getElementById("recipePagerInfo");
const recipePageIndicator = document.getElementById("recipePageIndicator");
const recipeFirstPageBtn = document.getElementById("recipeFirstPageBtn");
const recipePrevPageBtn = document.getElementById("recipePrevPageBtn");
const recipeNextPageBtn = document.getElementById("recipeNextPageBtn");
const recipeLastPageBtn = document.getElementById("recipeLastPageBtn");
const recipeResetFiltersBtn = document.getElementById("recipeResetFiltersBtn");
const recipeScopeSelect = document.getElementById("recipeScopeSelect");

const DEFAULT_RECIPE_QUERY = { search: "", scope: "all", sortBy: "name", sortDir: "asc", page: 1, pageSize: 20 };
const recipeQuery = { ...DEFAULT_RECIPE_QUERY };

/** Holt die zu recipeQuery passende Seite vom Server und zeichnet neu. */
async function loadRecipes(){
  const ok = await guard(() => DB.refreshRecipes(recipeQuery));
  if(ok){
    // Der Server kann die Seite begrenzt haben (z.B. nach einem Loeschen,
    // das die letzte Seite leert) - recipeQuery synchron halten, sonst
    // rechnen "Weiter"/"Zurueck" mit einer veralteten Seitenzahl.
    recipeQuery.page = DB.recipesPage.page;
  }
  renderRecipeTable();
}

/**
 * Festes 16x16-Kochbild-Symbol pro Zeile - immer dasselbe Bild, es zeigt nur,
 * ob das Rezept Fotos hat (kraeftig) oder keine (blass, durchgestrichen).
 */
function imageIndicator(imageCount){
  const has = imageCount > 0;
  const label = has
    ? (imageCount === 1 ? "1 Bild vorhanden" : `${imageCount} Bilder vorhanden`)
    : "Kein Bild";
  return `<svg class="recipe-img-icon ${has ? "has-image" : "no-image"}" width="16" height="16" role="img" aria-label="${label}"><title>${label}</title><use href="#${has ? "kochbild" : "kochbild-none"}"/></svg>`;
}

/** Spalte "Von": eigene Rezepte (ggf. mit Anzahl Freigaben) oder Besitzer + Recht. */
function ownerCell(recipe){
  if(recipe.access === "owner"){
    return `<span class="owner-self">Ich</span>` + (recipe.shareCount > 0
      ? `<span class="share-badge" title="Für ${recipe.shareCount} Benutzer freigegeben">🔗 ${recipe.shareCount}</span>`
      : "");
  }
  return escapeHtml(recipe.ownerName || "?") + (recipe.access === "write"
    ? `<span class="share-badge share-badge-write">bearbeiten</span>`
    : `<span class="share-badge">nur lesen</span>`);
}

/** Aktionen je nach Recht: Besitzer alles, Schreib-Freigabe nur bearbeiten, sonst ansehen. */
function recipeActions(recipe){
  const btn = (action, icon, label) =>
    `<button class="btn btn-icon" data-action="${action}" data-id="${recipe.id}" title="${label}" aria-label="${label}">${icon}</button>`;
  if(recipe.access === "owner"){
    return btn("edit", "✏️", "Bearbeiten") + btn("share", "🔗", "Freigeben") + btn("delete", "🗑️", "Löschen");
  }
  if(recipe.access === "write") return btn("edit", "✏️", "Bearbeiten");
  return btn("edit", "👁️", "Ansehen");
}

function renderRecipeTable(){
  const { items, total, page, totalPages } = DB.recipesPage;
  const hasSearch = recipeQuery.search.trim().length > 0;

  recipeTableBody.innerHTML = "";
  recipeEmptyState.hidden = items.length > 0;
  recipeEmptyState.textContent = hasSearch
    ? `Keine Rezepte gefunden für "${recipeQuery.search.trim()}".`
    : recipeQuery.scope === "shared"
      ? "Für dich sind noch keine Rezepte freigegeben."
      : 'Noch keine Rezepte vorhanden. Leg mit "Rezept erstellen" los.';

  items.forEach(recipe => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="recipe-name-cell">${imageIndicator(recipe.imageCount)}${escapeHtml(recipe.name)}</td>
      <td>${truncate(recipe.shortDesc, 100)}</td>
      <td class="owner-cell">${ownerCell(recipe)}</td>
      <td class="menu-cell">${recipeActions(recipe)}</td>
    `;
    recipeTableBody.appendChild(tr);
  });

  const pageSize = recipeQuery.pageSize;
  recipePagerInfo.textContent = total === 0
    ? "Keine Rezepte"
    : `Rezept ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} von ${total}`;
  recipePageIndicator.textContent = `Seite ${page} von ${totalPages}`;
  recipeFirstPageBtn.disabled = page <= 1;
  recipePrevPageBtn.disabled = page <= 1;
  recipeNextPageBtn.disabled = page >= totalPages;
  recipeLastPageBtn.disabled = page >= totalPages;
}

recipeTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if(!btn) return;
  const id = btn.dataset.id;

  if(btn.dataset.action === "edit"){
    btn.disabled = true;
    await guard(async () => {
      const recipe = await DB.getRecipe(id);
      openRecipeDialog(recipe);
    });
    btn.disabled = false;
    return;
  }

  if(btn.dataset.action === "share"){
    const recipe = DB.recipesPage.items.find(r => r.id === id);
    await openShareDialog(id, recipe ? recipe.name : "");
    return;
  }

  if(btn.dataset.action === "delete"){
    const recipe = DB.recipesPage.items.find(r => r.id === id);
    const ok = window.confirm(`Rezept "${recipe ? recipe.name : ""}" unwiderruflich löschen?`);
    if(!ok) return;
    await guard(async () => {
      await DB.deleteRecipe(id);
      await loadRecipes();
    }, { success: "Rezept gelöscht." });
  }
});

/* ---- Suche (debounced, Enter loest sofort aus) ---- */
let recipeSearchTimer = null;
recipeSearchInput.addEventListener("input", () => {
  clearTimeout(recipeSearchTimer);
  recipeSearchTimer = setTimeout(() => {
    recipeQuery.search = recipeSearchInput.value;
    recipeQuery.page = 1;
    loadRecipes();
  }, 300);
});
recipeSearchInput.addEventListener("keydown", (e) => {
  if(e.key !== "Enter") return;
  clearTimeout(recipeSearchTimer);
  recipeQuery.search = recipeSearchInput.value;
  recipeQuery.page = 1;
  loadRecipes();
});

/* ---- Auswahl: alle / meine / freigegebene ---- */
recipeScopeSelect.addEventListener("change", () => {
  recipeQuery.scope = recipeScopeSelect.value;
  recipeQuery.page = 1;
  loadRecipes();
});

/* ---- Sortierung ---- */
recipeSortSelect.addEventListener("change", () => {
  const [sortBy, sortDir] = recipeSortSelect.value.split("-");
  recipeQuery.sortBy = sortBy;
  recipeQuery.sortDir = sortDir;
  recipeQuery.page = 1;
  loadRecipes();
});

/* ---- Paging ---- */
recipePageSizeSelect.addEventListener("change", () => {
  recipeQuery.pageSize = Number(recipePageSizeSelect.value) || 20;
  recipeQuery.page = 1;
  loadRecipes();
});
recipeFirstPageBtn.addEventListener("click", () => { recipeQuery.page = 1; loadRecipes(); });
recipePrevPageBtn.addEventListener("click", () => { recipeQuery.page = Math.max(1, recipeQuery.page - 1); loadRecipes(); });
recipeNextPageBtn.addEventListener("click", () => { recipeQuery.page += 1; loadRecipes(); });
recipeLastPageBtn.addEventListener("click", () => { recipeQuery.page = DB.recipesPage.totalPages; loadRecipes(); });

/* ---- Filter zuruecksetzen ---- */
recipeResetFiltersBtn.addEventListener("click", () => {
  clearTimeout(recipeSearchTimer);
  Object.assign(recipeQuery, DEFAULT_RECIPE_QUERY);
  recipeSearchInput.value = "";
  recipeScopeSelect.value = "all";
  recipeSortSelect.value = "name-asc";
  recipePageSizeSelect.value = "20";
  loadRecipes();
});

/* =========================================================================
   Dialog "Kochbuch-Detail" — Rezept anlegen / bearbeiten
   ========================================================================= */
const recipeDialog = document.getElementById("recipeDialog");
const recipeForm = document.getElementById("recipeForm");
const recipeIdInput = document.getElementById("recipeId");
const recipeNameInput = document.getElementById("recipeName");
const recipeShortDescInput = document.getElementById("recipeShortDesc");
const recipeLongTextInput = document.getElementById("recipeLongText");
const ingredientList = document.getElementById("ingredientList");
const ingredientEmptyState = document.getElementById("ingredientEmptyState");
const ingredientNameInput = document.getElementById("ingredientNameInput");
const ingredientAmountInput = document.getElementById("ingredientAmountInput");
const ingredientCatalogList = document.getElementById("ingredientCatalogList");
const imageInput = document.getElementById("imageInput");
const imageListEl = document.getElementById("imageList");
const saveRecipeBtn = document.getElementById("saveRecipeBtn");
const recipeCategorySelect = document.getElementById("recipeCategory");

// Auswahlfeld: genau eine Kategorie oder keine. Die Liste kommt vom Server.
function fillCategorySelect(){
  recipeCategorySelect.innerHTML =
    `<option value="">– keine Kategorie –</option>` +
    DB.data.categoryOptions.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}

const recipeOwnerInfo = document.getElementById("recipeOwnerInfo");
let recipeReadOnly = false;    // fremdes Rezept, nur zum Lesen freigegeben
let workingIngredients = [];   // [{key, name, amount}]
let workingImages = [];        // gespeichert: {key, id, name, url} | neu: {key, name, dataUrl, isNew}

function refreshIngredientCatalogDatalist(){
  ingredientCatalogList.innerHTML = DB.data.ingredientCatalog
    .map(name => `<option value="${escapeHtml(name)}"></option>`)
    .join("");
}

function renderIngredientList(){
  ingredientEmptyState.hidden = workingIngredients.length > 0;
  ingredientList.innerHTML = workingIngredients.map(ing => `
    <li class="ingredient-row" data-key="${ing.key}">
      <input type="text" class="ingredient-edit-name" value="${escapeHtml(ing.name)}"${recipeReadOnly ? " disabled" : ""}>
      <input type="text" class="ingredient-edit-amount ingredient-amount" value="${escapeHtml(ing.amount)}"${recipeReadOnly ? " disabled" : ""}>
      <button type="button" class="btn btn-icon" data-action="remove-ingredient" aria-label="Zutat entfernen">✕</button>
    </li>
  `).join("");
}

ingredientList.addEventListener("input", (e) => {
  const row = e.target.closest("li.ingredient-row");
  if(!row) return;
  const ing = workingIngredients.find(i => i.key === row.dataset.key);
  if(!ing) return;
  if(e.target.classList.contains("ingredient-edit-name")) ing.name = e.target.value;
  if(e.target.classList.contains("ingredient-edit-amount")) ing.amount = e.target.value;
});

ingredientList.addEventListener("click", (e) => {
  const btn = e.target.closest('button[data-action="remove-ingredient"]');
  if(!btn) return;
  const row = e.target.closest("li.ingredient-row");
  workingIngredients = workingIngredients.filter(i => i.key !== row.dataset.key);
  renderIngredientList();
});

document.getElementById("addIngredientBtn").addEventListener("click", async () => {
  const name = ingredientNameInput.value.trim();
  const amount = ingredientAmountInput.value.trim();
  if(!name) return;

  workingIngredients.push({ key: makeId(), name, amount });
  ingredientNameInput.value = "";
  ingredientAmountInput.value = "";
  ingredientNameInput.focus();
  renderIngredientList();

  // Der Katalog ist nur eine Vorschlagsliste - ein Fehler hier darf die
  // Zutat im Formular nicht verhindern.
  try{
    await DB.addToIngredientCatalog(name);
    refreshIngredientCatalogDatalist();
  }catch(err){
    console.warn("Zutat konnte nicht in den Katalog übernommen werden:", err);
  }
});

function renderImageList(){
  imageListEl.innerHTML = workingImages.map(img => `
    <div class="image-thumb" data-key="${img.key}">
      <img src="${img.url || img.dataUrl}" alt="${escapeHtml(img.name)}" loading="lazy">
      <button type="button" class="image-remove" data-action="remove-image" aria-label="Bild entfernen">✕</button>
    </div>
  `).join("");
}

imageListEl.addEventListener("click", (e) => {
  const btn = e.target.closest('button[data-action="remove-image"]');
  if(!btn) return;
  const wrap = e.target.closest(".image-thumb");
  workingImages = workingImages.filter(i => i.key !== wrap.dataset.key);
  renderImageList();
});

/* ---- Bild-Lightbox: Doppelklick auf ein Bild zeigt es vergroessert ---- */
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");
const imageLightboxClose = document.getElementById("imageLightboxClose");

function openImageLightbox(src, alt){
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt;
  imageLightbox.hidden = false;
}

function closeImageLightbox(){
  imageLightbox.hidden = true;
  imageLightboxImg.src = ""; // grosse Data-URL nicht unnoetig im Speicher halten
}

imageListEl.addEventListener("dblclick", (e) => {
  const img = e.target.closest(".image-thumb img");
  if(!img) return;
  openImageLightbox(img.src, img.alt);
});

// Irgendwohin in die Lightbox klicken schliesst sie wieder (auch das Bild
// selbst - "nochmal anklicken zum Verkleinern" ist die erwartete Geste).
imageLightbox.addEventListener("click", closeImageLightbox);
imageLightboxClose.addEventListener("click", (e) => { e.stopPropagation(); closeImageLightbox(); });
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && !imageLightbox.hidden) closeImageLightbox();
});

imageInput.addEventListener("change", () => {
  const files = Array.from(imageInput.files || []);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      // Neue Bilder liegen bis zum Speichern als Data-URL im Formular und
      // wandern dann als Bytes in die Datenbank.
      workingImages.push({ key: makeId(), name: file.name, dataUrl: reader.result, isNew: true });
      renderImageList();
    };
    reader.onerror = () => showStatus(`Bild "${file.name}" konnte nicht gelesen werden.`, "error");
    reader.readAsDataURL(file);
  });
  imageInput.value = "";
});

/** Fremde Rezepte: Herkunft anzeigen; bei Nur-lesen-Freigabe alle Felder sperren. */
function applyRecipeAccess(recipe){
  recipeReadOnly = !!recipe && recipe.access === "read";
  recipeForm.classList.toggle("is-readonly", recipeReadOnly);
  recipeForm.querySelectorAll("input, textarea, select").forEach(el => {
    if(el.type !== "hidden") el.disabled = recipeReadOnly;
  });
  cancelRecipeBtn.textContent = recipeReadOnly ? "Schliessen" : "Abbrechen";

  if(recipe && recipe.access !== "owner"){
    recipeOwnerInfo.textContent = recipe.access === "write"
      ? `Rezept von ${recipe.ownerName} – für dich zum Bearbeiten freigegeben.`
      : `Rezept von ${recipe.ownerName} – für dich nur zum Lesen freigegeben.`;
    recipeOwnerInfo.hidden = false;
  }else{
    recipeOwnerInfo.hidden = true;
  }
}

function openRecipeDialog(recipe){
  refreshIngredientCatalogDatalist();
  fillCategorySelect();
  applyRecipeAccess(recipe);
  if(recipe){
    recipeCategorySelect.value = recipe.category || "";
    recipeIdInput.value = recipe.id;
    recipeNameInput.value = recipe.name;
    recipeShortDescInput.value = recipe.shortDesc || "";
    recipeLongTextInput.value = recipe.longText || "";
    workingIngredients = (recipe.ingredients || []).map(i => ({ key: i.id || makeId(), name: i.name, amount: i.amount || "" }));
    workingImages = (recipe.images || []).map(i => ({ key: i.id, id: i.id, name: i.name, url: i.url }));
  }else{
    recipeForm.reset();
    recipeIdInput.value = "";
    workingIngredients = [];
    workingImages = [];
  }
  renderIngredientList();
  renderImageList();
  recipeDialog.showModal();
  if(recipeReadOnly) cancelRecipeBtn.focus();
  else recipeNameInput.focus();
}

function closeRecipeDialog(){
  closeImageLightbox();
  recipeDialog.close();
}

document.getElementById("createRecipeBtn").addEventListener("click", () => openRecipeDialog(null));
const cancelRecipeBtn = document.getElementById("cancelRecipeBtn");
document.getElementById("closeDialogBtn").addEventListener("click", closeRecipeDialog);
cancelRecipeBtn.addEventListener("click", closeRecipeDialog);

recipeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(recipeReadOnly) return;
  if(!recipeNameInput.value.trim()){
    recipeNameInput.focus();
    return;
  }

  const payload = {
    id: recipeIdInput.value || undefined,
    name: recipeNameInput.value.trim(),
    shortDesc: recipeShortDescInput.value.trim(),
    longText: recipeLongTextInput.value,
    category: recipeCategorySelect.value,
    ingredients: workingIngredients.map(i => ({ name: i.name, amount: i.amount })),
    // Bereits gespeicherte Bilder nur per id referenzieren - die Bytes
    // liegen auf dem Server und muessen nicht erneut hochgeladen werden.
    images: workingImages.map(img => img.isNew
      ? { name: img.name, dataUrl: img.dataUrl }
      : { id: img.id, name: img.name })
  };

  saveRecipeBtn.disabled = true;
  saveRecipeBtn.textContent = "Speichert…";

  const ok = await guard(async () => {
    await DB.saveRecipe(payload);
    await loadRecipes();
    closeRecipeDialog();
  }, { success: "Rezept gespeichert." });

  saveRecipeBtn.disabled = false;
  saveRecipeBtn.textContent = "Speichern";
  if(!ok) recipeNameInput.focus();
});

/* =========================================================================
   Kuehlschrank
   ========================================================================= */
const fridgeForm = document.getElementById("fridgeForm");
const fridgeItemNameInput = document.getElementById("fridgeItemName");
const fridgeItemAmountInput = document.getElementById("fridgeItemAmount");
const fridgeListEl = document.getElementById("fridgeList");
const fridgeEmptyState = document.getElementById("fridgeEmptyState");
const clearFridgeBtn = document.getElementById("clearFridgeBtn");

function renderFridgeList(){
  const items = DB.data.fridge;
  fridgeEmptyState.hidden = items.length > 0;
  fridgeListEl.innerHTML = items.map(item => `
    <li class="fridge-item" data-id="${item.id}">
      <input type="text" class="fridge-edit-name" value="${escapeHtml(item.name)}">
      <input type="text" class="fridge-edit-amount fridge-item-amount" value="${escapeHtml(item.amount || "")}">
      <span class="fridge-item-actions">
        <button type="button" class="btn btn-icon" data-action="delete-fridge" aria-label="Löschen">🗑️</button>
      </span>
    </li>
  `).join("");
}

fridgeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = fridgeItemNameInput.value.trim();
  if(!name) return;
  await guard(async () => {
    await DB.addFridgeItem({ name, amount: fridgeItemAmountInput.value.trim() });
    fridgeForm.reset();
    fridgeItemNameInput.focus();
    renderFridgeList();
  });
});

/* Inline-Aenderungen werden gebuendelt: sonst ginge pro Tastendruck eine
   Anfrage an den Server. Beim Verlassen des Feldes wird sofort geschrieben. */
const pendingFridgeEdits = new Map();
const FRIDGE_SAVE_DELAY = 400;

function flushFridgeEdit(id){
  const entry = pendingFridgeEdits.get(id);
  if(!entry) return;
  clearTimeout(entry.timer);
  pendingFridgeEdits.delete(id);
  guard(() => DB.updateFridgeItem(id, entry.changes));
}

function queueFridgeEdit(id, changes){
  const entry = pendingFridgeEdits.get(id) || { changes: {}, timer: null };
  Object.assign(entry.changes, changes);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushFridgeEdit(id), FRIDGE_SAVE_DELAY);
  pendingFridgeEdits.set(id, entry);
}

fridgeListEl.addEventListener("input", (e) => {
  const row = e.target.closest("li.fridge-item");
  if(!row) return;
  const changes = {};
  if(e.target.classList.contains("fridge-edit-name")){
    if(!e.target.value.trim()) return;  // leerer Name waere ungueltig
    changes.name = e.target.value;
  }
  if(e.target.classList.contains("fridge-edit-amount")) changes.amount = e.target.value;
  if(Object.keys(changes).length) queueFridgeEdit(row.dataset.id, changes);
});

fridgeListEl.addEventListener("focusout", (e) => {
  const row = e.target.closest("li.fridge-item");
  if(row) flushFridgeEdit(row.dataset.id);
});

fridgeListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest('button[data-action="delete-fridge"]');
  if(!btn) return;
  const row = e.target.closest("li.fridge-item");
  const id = row.dataset.id;
  pendingFridgeEdits.delete(id);   // ausstehende Aenderung ist hinfaellig
  await guard(async () => {
    await DB.deleteFridgeItem(id);
    renderFridgeList();
  });
});

clearFridgeBtn.addEventListener("click", async () => {
  if(DB.data.fridge.length === 0) return;
  const ok = window.confirm("Den gesamten Kühlschrank leeren?");
  if(!ok) return;
  pendingFridgeEdits.clear();
  await guard(async () => {
    await DB.clearFridge();
    renderFridgeList();
  }, { success: "Kühlschrank geleert." });
});

/* =========================================================================
   Einmalige Uebernahme alter Browser-Daten.
   Frueher lag alles in localStorage. Steht dort noch etwas und ist der
   Server leer, wird die Uebernahme einmal angeboten.
   ========================================================================= */
const LEGACY_KEY = "kochbuchV2_db";
const LEGACY_DONE_KEY = "kochbuchV2_migrated";

async function offerLegacyImport(){
  if(window.localStorage.getItem(LEGACY_DONE_KEY)) return false;

  let legacy;
  try{
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if(!raw) return false;
    legacy = JSON.parse(raw);
  }catch{
    return false;
  }

  const recipeCount = Array.isArray(legacy.recipes) ? legacy.recipes.length : 0;
  const fridgeCount = Array.isArray(legacy.fridge) ? legacy.fridge.length : 0;
  if(recipeCount + fridgeCount === 0) return false;

  // Nur anbieten, solange auf dem Server noch nichts liegt.
  if(DB.recipesPage.total > 0 || DB.data.fridge.length > 0) return false;

  const ok = window.confirm(
    `Im Browser liegen noch Daten aus der localStorage-Version:\n` +
    `${recipeCount} Rezept(e), ${fridgeCount} Kühlschrank-Eintrag/-Einträge.\n\n` +
    `In die Datenbank auf dem Server übernehmen?`
  );
  if(!ok){
    window.localStorage.setItem(LEGACY_DONE_KEY, "abgelehnt");
    return false;
  }

  return guard(async () => {
    const result = await API.post("/import", legacy);
    window.localStorage.setItem(LEGACY_DONE_KEY, new Date().toISOString());
    await DB.load();
    await loadRecipes();
    renderFridgeList();
    showStatus(`Übernommen: ${result.recipes} Rezept(e), ${result.fridge} Kühlschrank-Eintrag/-Einträge.`, "success");
  });
}

/* =========================================================================
   Freigaben — der Besitzer legt pro Benutzer fest: keine, lesen, bearbeiten.
   ========================================================================= */
const shareDialog = document.getElementById("shareDialog");
const shareForm = document.getElementById("shareForm");
const shareList = document.getElementById("shareList");
const shareEmptyState = document.getElementById("shareEmptyState");
const shareRecipeName = document.getElementById("shareRecipeName");
let shareRecipeId = null;

async function openShareDialog(recipeId, recipeName){
  await guard(async () => {
    const [users, shares] = await Promise.all([
      API.get("/users"),
      API.get(`/recipes/${enc(recipeId)}/shares`)
    ]);
    const byUser = new Map(shares.map(s => [s.userId, s.canWrite ? "write" : "read"]));
    const others = users.filter(u => u.id !== currentUser.id);

    shareRecipeId = recipeId;
    shareRecipeName.textContent = `„${recipeName}" – wer darf es sehen oder bearbeiten?`;
    shareEmptyState.hidden = others.length > 0;
    shareList.innerHTML = others.map(u => {
      const value = byUser.get(u.id) || "";
      const opt = (v, label) => `<option value="${v}"${v === value ? " selected" : ""}>${label}</option>`;
      return `
        <li class="share-row">
          <span>${escapeHtml(u.username)}</span>
          <select data-user-id="${u.id}" aria-label="Freigabe für ${escapeHtml(u.username)}">
            ${opt("", "Keine Freigabe")}${opt("read", "Nur lesen")}${opt("write", "Lesen und bearbeiten")}
          </select>
        </li>`;
    }).join("");
    shareDialog.showModal();
  });
}

shareForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const shares = [...shareList.querySelectorAll("select[data-user-id]")]
    .filter(sel => sel.value)
    .map(sel => ({ userId: sel.dataset.userId, canWrite: sel.value === "write" }));
  const ok = await guard(async () => {
    await API.put(`/recipes/${enc(shareRecipeId)}/shares`, shares);
    await loadRecipes();
  }, { success: "Freigaben gespeichert." });
  if(ok) shareDialog.close();
});

// Alle kleinen Dialoge: Buttons mit data-close schliessen ihren Dialog.
document.querySelectorAll("dialog [data-close]").forEach(btn => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
});
// Eine alte Meldung soll beim naechsten Oeffnen nicht mehr dastehen.
document.querySelectorAll("dialog").forEach(dialog => {
  dialog.addEventListener("close", () => {
    dialog.querySelectorAll(".dialog-status").forEach(el => { el.hidden = true; });
  });
});

/* =========================================================================
   Benutzerverwaltung — nur fuer Admins sichtbar.
   ========================================================================= */
const usersDialog = document.getElementById("usersDialog");
const usersTableBody = document.getElementById("usersTableBody");
const newUserForm = document.getElementById("newUserForm");
let userList = [];

async function loadUsers(){
  userList = await API.get("/users");
  renderUsers();
}

function renderUsers(){
  usersTableBody.innerHTML = userList.map(u => {
    const self = u.id === currentUser.id;
    return `
      <tr data-id="${u.id}">
        <td>${escapeHtml(u.username)}${self ? ' <span class="owner-self">(ich)</span>' : ""}</td>
        <td><input type="checkbox" data-action="toggle-admin" ${u.isAdmin ? "checked" : ""} ${self ? "disabled" : ""} aria-label="Admin"></td>
        <td>${u.recipeCount}</td>
        <td class="menu-cell">
          <button type="button" class="btn btn-ghost btn-small" data-action="password">Passwort setzen</button>
          ${self ? "" : `<button type="button" class="btn btn-icon" data-action="delete-user" title="Löschen" aria-label="Löschen">🗑️</button>`}
        </td>
      </tr>`;
  }).join("");
}

usersTableBody.addEventListener("change", async (e) => {
  if(e.target.dataset.action !== "toggle-admin") return;
  const id = e.target.closest("tr").dataset.id;
  const ok = await guard(() => API.patch(`/users/${enc(id)}`, { isAdmin: e.target.checked }),
    { success: "Rechte geändert." });
  if(!ok) e.target.checked = !e.target.checked;
});

usersTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if(!btn) return;
  const row = btn.closest("tr");
  const user = userList.find(u => u.id === row.dataset.id);
  const cell = btn.closest(".menu-cell");

  if(btn.dataset.action === "password"){
    // Passwortfeld direkt in der Zeile statt window.prompt (das zeigt Klartext).
    cell.innerHTML = `
      <input type="password" placeholder="Neues Passwort" autocomplete="new-password" maxlength="200">
      <button type="button" class="btn btn-primary btn-small" data-action="password-save">OK</button>
      <button type="button" class="btn btn-ghost btn-small" data-action="password-cancel">Abbrechen</button>`;
    cell.querySelector("input").focus();
    return;
  }
  if(btn.dataset.action === "password-cancel"){
    renderUsers();
    return;
  }
  if(btn.dataset.action === "password-save"){
    const password = cell.querySelector("input").value;
    const ok = await guard(() => API.patch(`/users/${enc(user.id)}`, { password }),
      { success: `Neues Passwort für ${user.username} gesetzt.` });
    if(ok) renderUsers();
    return;
  }
  if(btn.dataset.action === "delete-user"){
    const ok = window.confirm(
      `Benutzer "${user.username}" löschen?\n\n` +
      (user.recipeCount > 0 ? `Seine ${user.recipeCount} Rezept(e) gehen an dich über.` : "Er hat keine eigenen Rezepte.")
    );
    if(!ok) return;
    await guard(async () => {
      await API.del(`/users/${enc(user.id)}`);
      await loadUsers();
      await loadRecipes();
    }, { success: `Benutzer ${user.username} gelöscht.` });
  }
});

newUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("newUserName").value.trim();
  await guard(async () => {
    await API.post("/users", {
      username,
      password: document.getElementById("newUserPassword").value,
      isAdmin: document.getElementById("newUserAdmin").checked
    });
    newUserForm.reset();
    await loadUsers();
  }, { success: `Benutzer ${username} angelegt.` });
});

document.getElementById("usersBtn").addEventListener("click", async () => {
  await guard(async () => {
    await loadUsers();
    usersDialog.showModal();
  });
});

/* =========================================================================
   Eigenes Passwort aendern
   ========================================================================= */
const passwordDialog = document.getElementById("passwordDialog");
const passwordForm = document.getElementById("passwordForm");
const passwordError = document.getElementById("passwordError");

document.getElementById("passwordBtn").addEventListener("click", () => {
  passwordForm.reset();
  passwordError.hidden = true;
  passwordDialog.showModal();
});

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newPassword = document.getElementById("newPassword").value;
  if(newPassword !== document.getElementById("newPasswordRepeat").value){
    passwordError.textContent = "Die beiden neuen Passwörter stimmen nicht überein.";
    passwordError.hidden = false;
    return;
  }
  try{
    await API.post("/auth/password", {
      currentPassword: document.getElementById("currentPassword").value,
      newPassword
    });
    passwordDialog.close();
    showStatus("Passwort geändert.", "success");
  }catch(err){
    passwordError.textContent = err.message;
    passwordError.hidden = false;
  }
});

/* =========================================================================
   Anmeldung — ohne Sitzung sieht man nur das Anmeldeformular. Gibt es noch
   gar keinen Benutzer, legt dasselbe Formular den ersten Admin an.
   ========================================================================= */
const authScreen = document.getElementById("authScreen");
const authForm = document.getElementById("authForm");
const authHeading = document.getElementById("authHeading");
const authHint = document.getElementById("authHint");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const authPasswordRepeat = document.getElementById("authPasswordRepeat");
const authPasswordRepeatField = document.getElementById("authPasswordRepeatField");
const authError = document.getElementById("authError");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const appMain = document.getElementById("appMain");
const userBar = document.getElementById("userBar");
const currentUserName = document.getElementById("currentUserName");
const usersBtn = document.getElementById("usersBtn");

let currentUser = null;
let setupMode = false;

function showAuthScreen(setupRequired){
  currentUser = null;
  setupMode = setupRequired;
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
  appMain.hidden = true;
  userBar.hidden = true;
  authScreen.hidden = false;
  clearStatus();

  authHeading.textContent = setupMode ? "Ersteinrichtung" : "Anmelden";
  authHint.textContent = setupMode
    ? "Es gibt noch keinen Benutzer. Lege jetzt den Administrator an – die vorhandenen Rezepte gehören danach diesem Konto."
    : "Bitte mit Benutzername und Passwort anmelden.";
  authPasswordRepeatField.hidden = !setupMode;
  authPasswordRepeat.required = setupMode;
  authPassword.autocomplete = setupMode ? "new-password" : "current-password";
  authSubmitBtn.textContent = setupMode ? "Administrator anlegen" : "Anmelden";
  authError.hidden = true;
  authPassword.value = "";
  authPasswordRepeat.value = "";
  authUsername.focus();
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  if(setupMode && authPassword.value !== authPasswordRepeat.value){
    authError.textContent = "Die beiden Passwörter stimmen nicht überein.";
    authError.hidden = false;
    return;
  }
  authSubmitBtn.disabled = true;
  try{
    const { user } = await API.post(setupMode ? "/auth/setup" : "/auth/login", {
      username: authUsername.value.trim(),
      password: authPassword.value
    });
    authForm.reset();
    await startApp(user);
  }catch(err){
    authError.textContent = err.message;
    authError.hidden = false;
  }finally{
    authSubmitBtn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await guard(() => API.post("/auth/logout"));
  recommendationsRow.innerHTML = "";
  lastRecommendationIds = [];
  showAuthScreen(false);
});

/** Nach erfolgreicher Anmeldung: Kopfzeile setzen und Daten laden. */
async function startApp(user){
  currentUser = user;
  currentUserName.innerHTML = escapeHtml(user.username) +
    (user.isAdmin ? '<span class="user-role">Admin</span>' : "");
  usersBtn.hidden = !user.isAdmin;
  userBar.hidden = false;
  authScreen.hidden = true;
  appMain.hidden = false;

  // Ansicht eines vorher angemeldeten Benutzers nicht stehen lassen.
  Object.assign(recipeQuery, DEFAULT_RECIPE_QUERY);
  recipeSearchInput.value = "";
  recipeScopeSelect.value = "all";
  recipeSortSelect.value = "name-asc";
  recipePageSizeSelect.value = "20";

  const loaded = await guard(() => DB.load());
  if(!loaded) return;
  await loadRecipes();
  clearStatus();
  renderFridgeList();
  await offerLegacyImport();
}

/* =========================================================================
   Start
   ========================================================================= */
(async function init(){
  let status;
  try{
    status = await API.get("/auth/status");
  }catch(err){
    // Ohne Serververbindung hat Weiterarbeiten keinen Sinn - die
    // Fehlermeldung bleibt stehen.
    showStatus(err.message, "error");
    return;
  }
  if(status.user) await startApp(status.user);
  else showAuthScreen(status.setupRequired);
})();
