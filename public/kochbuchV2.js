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
  data: { recipes: [], fridge: [], ingredientCatalog: [] },

  async load(){
    this.data = await API.get("/state");
    return this.data;
  },

  // ---- Rezepte ----
  // Die Uebersicht in data.recipes enthaelt nur Kopfdaten; Zutaten und
  // Bilder kommen erst beim Oeffnen eines Rezepts dazu.
  async getRecipe(id){
    return API.get(`/recipes/${enc(id)}`);
  },
  async saveRecipe(recipe){
    const saved = recipe.id
      ? await API.put(`/recipes/${enc(recipe.id)}`, recipe)
      : await API.post("/recipes", recipe);
    await this.refreshRecipes();
    await this.refreshCatalog();
    return saved;
  },
  async deleteRecipe(id){
    await API.del(`/recipes/${enc(id)}`);
    await this.refreshRecipes();
  },
  async refreshRecipes(){
    this.data.recipes = await API.get("/recipes");
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

function showStatus(message, kind = "info"){
  clearTimeout(statusTimer);
  statusBar.textContent = message;
  statusBar.dataset.kind = kind;
  statusBar.hidden = false;
  if(kind !== "error"){
    statusTimer = setTimeout(() => { statusBar.hidden = true; }, 3000);
  }
}

function clearStatus(){
  clearTimeout(statusTimer);
  statusBar.hidden = true;
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
    console.error("KochbuchV2:", err);
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
  window.localStorage.setItem("kochbuchV2_theme", theme);
}

(function initTheme(){
  const saved = window.localStorage.getItem("kochbuchV2_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
})();

themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

/* =========================================================================
   Rezept-Uebersicht (Tabelle)
   ========================================================================= */
const recipeTableBody = document.getElementById("recipeTableBody");
const recipeEmptyState = document.getElementById("recipeEmptyState");

function renderRecipeTable(){
  const recipes = DB.data.recipes;
  recipeTableBody.innerHTML = "";
  recipeEmptyState.hidden = recipes.length > 0;

  recipes.forEach(recipe => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="recipe-name-cell">${escapeHtml(recipe.name)}</td>
      <td>${truncate(recipe.shortDesc, 100)}</td>
      <td class="menu-cell">
        <button class="btn btn-icon" data-action="edit" data-id="${recipe.id}" title="Bearbeiten" aria-label="Bearbeiten">✏️</button>
        <button class="btn btn-icon" data-action="delete" data-id="${recipe.id}" title="Löschen" aria-label="Löschen">🗑️</button>
      </td>
    `;
    recipeTableBody.appendChild(tr);
  });
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

  if(btn.dataset.action === "delete"){
    const recipe = DB.data.recipes.find(r => r.id === id);
    const ok = window.confirm(`Rezept "${recipe ? recipe.name : ""}" unwiderruflich löschen?`);
    if(!ok) return;
    await guard(async () => {
      await DB.deleteRecipe(id);
      renderRecipeTable();
    }, { success: "Rezept gelöscht." });
  }
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
      <input type="text" class="ingredient-edit-name" value="${escapeHtml(ing.name)}">
      <input type="text" class="ingredient-edit-amount ingredient-amount" value="${escapeHtml(ing.amount)}">
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

function openRecipeDialog(recipe){
  refreshIngredientCatalogDatalist();
  if(recipe){
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
  recipeNameInput.focus();
}

function closeRecipeDialog(){
  recipeDialog.close();
}

document.getElementById("createRecipeBtn").addEventListener("click", () => openRecipeDialog(null));
document.getElementById("closeDialogBtn").addEventListener("click", closeRecipeDialog);
document.getElementById("cancelRecipeBtn").addEventListener("click", closeRecipeDialog);

recipeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(!recipeNameInput.value.trim()){
    recipeNameInput.focus();
    return;
  }

  const payload = {
    id: recipeIdInput.value || undefined,
    name: recipeNameInput.value.trim(),
    shortDesc: recipeShortDescInput.value.trim(),
    longText: recipeLongTextInput.value,
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
    renderRecipeTable();
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
  if(DB.data.recipes.length > 0 || DB.data.fridge.length > 0) return false;

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
    showStatus(`Übernommen: ${result.recipes} Rezept(e), ${result.fridge} Kühlschrank-Eintrag/-Einträge.`, "success");
  });
}

/* =========================================================================
   Start
   ========================================================================= */
(async function init(){
  const loaded = await guard(() => DB.load());
  if(!loaded){
    // Ohne Serververbindung hat Weiterarbeiten keinen Sinn - die Oberflaeche
    // bleibt leer und die Fehlermeldung stehen.
    return;
  }
  clearStatus();
  renderRecipeTable();
  renderFridgeList();
  await offerLegacyImport();
  renderRecipeTable();
  renderFridgeList();
})();
