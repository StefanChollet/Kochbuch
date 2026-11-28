"use strict";

/* =========================================================================
   Detailseite einer Reise — anlegen (reise.html), ansehen und bearbeiten
   (reise.html?id=...). Aufbau wie das Kochbuch-Detail: Kopfdaten,
   Reiseart (hoechstens eine), Stationen als Liste, Bericht, Bilder.
   ========================================================================= */
const tripForm = document.getElementById("tripForm");
const detailHeading = document.getElementById("detailHeading");
const tripOwnerInfo = document.getElementById("tripOwnerInfo");
const tripNameInput = document.getElementById("tripName");
const tripShortDescInput = document.getElementById("tripShortDesc");
const tripDestinationInput = document.getElementById("tripDestination");
const tripStartDateInput = document.getElementById("tripStartDate");
const tripEndDateInput = document.getElementById("tripEndDate");
const tripLongTextInput = document.getElementById("tripLongText");
const categoryList = document.getElementById("categoryList");
const categoryEmptyState = document.getElementById("categoryEmptyState");
const categoryNameInput = document.getElementById("categoryNameInput");
const categoryOptionsList = document.getElementById("categoryOptionsList");
const categoryAddRow = document.getElementById("categoryAddRow");
const stationList = document.getElementById("stationList");
const stationEmptyState = document.getElementById("stationEmptyState");
const stationNameInput = document.getElementById("stationNameInput");
const stationNoteInput = document.getElementById("stationNoteInput");
const imageInput = document.getElementById("imageInput");
const imageListEl = document.getElementById("imageList");
const saveTripBtn = document.getElementById("saveTripBtn");
const deleteTripBtn = document.getElementById("deleteTripBtn");
const cancelBtn = document.getElementById("cancelBtn");

let tripId = new URLSearchParams(window.location.search).get("id") || "";   // neue Reise: wird beim ersten Bild angelegt
let readOnly = false;
let dirty = false;           // ungespeicherte Aenderungen -> Nachfrage beim Verlassen
let leaving = false;         // gewollter Seitenwechsel (nach Speichern/Loeschen)
let workingCategories = [];  // [{key, name}] - hoechstens ein Eintrag
let workingStations = [];    // [{key, name, note}]
let workingImages = [];      // gespeichert: {key, id, name, url} | neu: {key, name, dataUrl, isNew}

/* ---- Zurueck zur Uebersicht - immer die eigene Startseite ---- */
function backToOverview(){
  leaving = true;
  window.location.href = "./";
}

function confirmLeave(){
  return !dirty || readOnly || window.confirm("Es gibt ungespeicherte Änderungen. Trotzdem verlassen?");
}

document.getElementById("backBtn").addEventListener("click", () => { if(confirmLeave()) backToOverview(); });
cancelBtn.addEventListener("click", () => { if(confirmLeave()) backToOverview(); });

window.addEventListener("beforeunload", (e) => {
  if(dirty && !readOnly && !leaving){ e.preventDefault(); e.returnValue = ""; }
});
tripForm.addEventListener("input", () => { dirty = true; });

/* ---- Reiseart ---- */
function renderCategoryList(){
  categoryEmptyState.hidden = workingCategories.length > 0;
  categoryAddRow.hidden = workingCategories.length > 0 || readOnly;
  categoryList.innerHTML = workingCategories.map(cat => `
    <li class="item-row" data-key="${cat.key}">
      <input type="text" class="category-edit-name" value="${escapeHtml(cat.name)}" maxlength="40" aria-label="Reiseart"${readOnly ? " disabled" : ""}>
      <button type="button" class="btn btn-icon" data-action="remove-category" aria-label="Reiseart entfernen">✕</button>
    </li>
  `).join("");
}

categoryList.addEventListener("input", (e) => {
  const row = e.target.closest("li.item-row");
  const cat = row && workingCategories.find(c => c.key === row.dataset.key);
  if(cat) cat.name = e.target.value;
});

categoryList.addEventListener("click", (e) => {
  if(!e.target.closest('button[data-action="remove-category"]')) return;
  const row = e.target.closest("li.item-row");
  workingCategories = workingCategories.filter(c => c.key !== row.dataset.key);
  dirty = true;
  renderCategoryList();
  categoryNameInput.focus();
});

function takePendingCategory(){
  const name = categoryNameInput.value.trim();
  if(!name) return "";
  categoryNameInput.value = "";
  if(workingCategories.length === 0) workingCategories.push({ key: makeId(), name });
  dirty = true;
  renderCategoryList();
  return name;
}

document.getElementById("addCategoryBtn").addEventListener("click", takePendingCategory);
categoryNameInput.addEventListener("keydown", (e) => {
  if(e.key !== "Enter") return;
  e.preventDefault();
  takePendingCategory();
});

/* ---- Stationen ---- */
function renderStationList(){
  stationEmptyState.hidden = workingStations.length > 0;
  stationList.innerHTML = workingStations.map((st, index) => `
    <li class="item-row" data-key="${st.key}">
      <span class="station-pos" aria-hidden="true">${index + 1}</span>
      <input type="text" class="station-edit-name" value="${escapeHtml(st.name)}" maxlength="80" aria-label="Station ${index + 1}"${readOnly ? " disabled" : ""}>
      <input type="text" class="station-edit-note station-note" value="${escapeHtml(st.note)}" maxlength="60" aria-label="Datum oder Notiz zu Station ${index + 1}"${readOnly ? " disabled" : ""}>
      <button type="button" class="btn btn-icon" data-action="remove-station" aria-label="Station entfernen">✕</button>
    </li>
  `).join("");
}

stationList.addEventListener("input", (e) => {
  const row = e.target.closest("li.item-row");
  const st = row && workingStations.find(s => s.key === row.dataset.key);
  if(!st) return;
  if(e.target.classList.contains("station-edit-name")) st.name = e.target.value;
  if(e.target.classList.contains("station-edit-note")) st.note = e.target.value;
});

stationList.addEventListener("click", (e) => {
  if(!e.target.closest('button[data-action="remove-station"]')) return;
  const row = e.target.closest("li.item-row");
  workingStations = workingStations.filter(s => s.key !== row.dataset.key);
  dirty = true;
  renderStationList();
});

function takePendingStation(){
  const name = stationNameInput.value.trim();
  const note = stationNoteInput.value.trim();
  if(!name) return "";
  workingStations.push({ key: makeId(), name, note });
  stationNameInput.value = "";
  stationNoteInput.value = "";
  dirty = true;
  renderStationList();
  return name;
}

document.getElementById("addStationBtn").addEventListener("click", () => {
  if(takePendingStation()) stationNameInput.focus();
});
[stationNameInput, stationNoteInput].forEach(input => input.addEventListener("keydown", (e) => {
  if(e.key !== "Enter") return;
  e.preventDefault();
  if(takePendingStation()) stationNameInput.focus();
}));

/* ---- Bilder ---- */
/** Zeichenblatt mit gespeichertem Inhalt - laesst sich wieder bearbeiten. */
const isEditableDrawing = (img) => !!(img.scene || img.hasScene);

function renderImageList(focusKey){
  const count = workingImages.length;
  imageListEl.innerHTML = workingImages.map((img, i) => `
    <div class="image-thumb" data-key="${img.key}" tabindex="0" draggable="${readOnly ? "false" : "true"}"
         aria-label="Bild ${i + 1} von ${count}: ${escapeHtml(img.name)}"
         title="${readOnly ? "Doppelklick: vergrößern" : "Ziehen: neu anordnen · Rechtsklick: Menü · Doppelklick: vergrößern"}">
      <img src="${escapeHtml(img.url || img.dataUrl)}" alt="${escapeHtml(img.name)}" loading="lazy" draggable="false">
      <button type="button" class="image-menu-btn" data-action="image-menu" aria-label="Menü für dieses Bild" aria-haspopup="menu">⋯</button>
      ${isEditableDrawing(img) ? `<button type="button" class="image-edit" data-action="edit-drawing" title="Zeichenblatt mit allen Objekten wieder bearbeiten">✎ Bearbeiten</button>` : ""}
      <button type="button" class="image-remove" data-action="remove-image" aria-label="Bild entfernen">✕</button>
      ${img.saving ? `<span class="image-state is-saving" role="status">Speichert…</span>`
        : img.isNew ? `<span class="image-state is-pending" title="Wird mit „Speichern“ in der Reise gesichert">nicht gespeichert</span>` : ""}
    </div>
  `).join("");
  if(focusKey) imageListEl.querySelector(`.image-thumb[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

/** Zeitpunkt, zu dem ein gespeichertes Bild entstand: Erstellzeit oder Zeitstempel in der id. */
function imageTime(img){
  if(img.createdAt){ const t = Date.parse(img.createdAt); if(Number.isFinite(t)) return t; }
  if(img.id){ const t = parseInt(img.id.slice(0, -8), 36); if(Number.isFinite(t)) return t; }
  return null;
}

/* Zeichenblatt wieder bearbeiten: Inhalt laden, Zeichenblatt oeffnen, das
   Ergebnis ersetzt das bisherige Bild an derselben Stelle und behaelt
   seine Erstellzeit (Reihenfolge in der Dia-Show bleibt). */
imageListEl.addEventListener("click", async (e) => {
  const editBtn = e.target.closest('button[data-action="edit-drawing"]');
  if(!editBtn || readOnly) return;
  const key = editBtn.closest(".image-thumb").dataset.key;
  const original = workingImages.find(i => i.key === key);
  if(!original) return;
  editBtn.disabled = true;
  let scene = null;
  const ok = await guard(async () => {
    scene = original.scene ? JSON.parse(original.scene) : await API.get(`/images/${enc(original.id)}/scene`);
  });
  editBtn.disabled = false;
  if(!ok || !scene) return;
  const time = imageTime(original);
  Zeichnen.open(({ name, dataUrl, scene: newScene }) => {
    const idx = workingImages.findIndex(i => i.key === key);
    if(idx === -1) return;
    const entry = { key: makeId(), name, dataUrl, scene: newScene, isNew: true,
      createdAt: time ? new Date(time).toISOString() : undefined };
    workingImages[idx] = entry;
    renderImageList();
    // gespeichertes Zeichenblatt: auf dem Server an derselben Stelle ersetzen
    storeImageNow(entry, original.id || null, "Zeichenblatt");
  }, { scene, name: original.name });
});

imageListEl.addEventListener("click", (e) => {
  if(!e.target.closest('button[data-action="remove-image"]')) return;
  const wrap = e.target.closest(".image-thumb");
  workingImages = workingImages.filter(i => i.key !== wrap.dataset.key);
  dirty = true;
  renderImageList();
});

/* ---- Bilder sofort dauerhaft speichern ----
   Ein hochgeladenes Foto oder ein uebernommenes Zeichenblatt geht sofort an
   den Server (Datenbank auf trex) - nicht erst mit "Speichern" der Reise.
   Die Uploads laufen nacheinander (Warteschlange), damit die Reihenfolge
   stimmt und eine neue Reise nur einmal angelegt wird. Bei einer neuen Reise
   ohne Namen bleibt das Bild vorgemerkt, bis die Reise gespeichert wird. */
let uploadQueue = Promise.resolve();

function storeImageNow(entry, replaces, label = "Bild"){
  entry.saving = true;
  renderImageList();
  const job = uploadQueue.then(() => uploadImage(entry, replaces, label));
  uploadQueue = job.catch(() => {});
  return job;
}

async function uploadImage(entry, replaces, label){
  // Inzwischen entfernt? Dann nicht mehr speichern.
  if(!workingImages.includes(entry)) return;
  try{
    if(!tripId){
      const created = await createTripWithImages();
      if(created){
        showStatus(`${label} gespeichert – die Reise „${created.name}“ wurde dabei angelegt.`, "success");
      }else{
        entry.saving = false;
        dirty = true;
        renderImageList();
        showStatus(`${label} vorgemerkt – bitte einen Reisenamen eingeben, dann wird es mit „Speichern“ dauerhaft gesichert.`, "info");
      }
      return;
    }
    const saved = await API.post(`/trips/${enc(tripId)}/images`, {
      name: entry.name, dataUrl: entry.dataUrl, scene: entry.scene || undefined,
      createdAt: entry.createdAt || undefined, replaces: replaces || undefined
    });
    Object.assign(entry, { id: saved.id, url: saved.url, name: saved.name, hasScene: !!saved.hasScene,
      createdAt: saved.createdAt, isNew: false, saving: false });
    delete entry.dataUrl;
    delete entry.scene;
    renderImageList();
    showStatus(`${label} „${saved.name}“ ist dauerhaft gespeichert.`, "success");
  }catch(err){
    console.error("Travelfy:", err);
    entry.saving = false;
    dirty = true;          // bleibt vorgemerkt und geht mit "Speichern" mit
    renderImageList();
    showStatus(`${label} konnte nicht sofort gespeichert werden (${err.message}) – es wird mit „Speichern“ erneut versucht.`, "error");
  }
}

/** Formularinhalt als Reise-Daten (fuer Speichern und das automatische Anlegen). */
function tripPayload(){
  return {
    name: tripNameInput.value.trim(),
    shortDesc: tripShortDescInput.value.trim(),
    destination: tripDestinationInput.value.trim(),
    startDate: tripStartDateInput.value,
    endDate: tripEndDateInput.value,
    longText: tripLongTextInput.value,
    categories: workingCategories.map(c => c.name),
    stations: workingStations.map(s => ({ name: s.name, note: s.note })),
    images: workingImages.map(img => img.isNew
      ? { name: img.name, dataUrl: img.dataUrl, scene: img.scene || undefined, createdAt: img.createdAt || undefined }
      : { id: img.id, name: img.name })
  };
}

/**
 * Neue Reise beim ersten Bild anlegen (samt allen vorgemerkten Bildern),
 * sofern sie schon einen Namen hat. Danach ist die Seite eine normale
 * Bearbeiten-Seite (Adresse mit ?id=). Ohne Namen: null.
 */
async function createTripWithImages(){
  if(!tripNameInput.value.trim()) return null;
  if(tripStartDateInput.value && tripEndDateInput.value && tripEndDateInput.value < tripStartDateInput.value) return null;
  const sent = [...workingImages];
  const trip = await API.post("/trips", tripPayload());
  tripId = trip.id;
  loadedTrip = trip;
  history.replaceState(null, "", `reise.html?id=${enc(trip.id)}`);
  // Der Server speichert die Bilder in der geschickten Reihenfolge
  sent.forEach((entry, i) => {
    const img = trip.images[i];
    if(!img) return;
    Object.assign(entry, { id: img.id, url: img.url, name: img.name, hasScene: !!img.hasScene,
      createdAt: img.createdAt, isNew: false, saving: false });
    delete entry.dataUrl;
    delete entry.scene;
  });
  detailHeading.textContent = trip.name;
  document.title = `Travelfy – ${trip.name}`;
  dirty = workingImages.some(i => i.isNew);
  applyAccess();     // u.a. "Reise löschen" einblenden
  return trip;
}

const pendingImageReads = new Set();

imageInput.addEventListener("change", () => {
  Array.from(imageInput.files || []).forEach(file => {
    const read = new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const entry = { key: makeId(), name: file.name, dataUrl: reader.result, isNew: true };
        workingImages.push(entry);
        renderImageList();
        storeImageNow(entry, null, "Foto");
        resolve();
      };
      reader.onerror = () => {
        showStatus(`Bild "${file.name}" konnte nicht gelesen werden.`, "error");
        resolve();
      };
      reader.readAsDataURL(file);
    });
    pendingImageReads.add(read);
    read.then(() => pendingImageReads.delete(read));
  });
  imageInput.value = "";
});

/* ---- Zeichenblatt: die fertige Zeichnung wird ein neues Bild der Reise ---- */
document.getElementById("drawBtn").addEventListener("click", () => {
  if(readOnly) return;
  Zeichnen.open(({ name, dataUrl, scene }) => {
    const entry = { key: makeId(), name, dataUrl, scene, isNew: true };
    workingImages.push(entry);
    renderImageList();
    storeImageNow(entry, null, "Zeichnung");
  });
});

/* ---- Dia-Show: alle Bilder der Reise in der Reihenfolge des Blocks "Bilder" ----
   Wer chronologisch moechte, sortiert vorher per Kontextmenue "Älteste zuerst".
   Auch ungespeicherte Aenderungen der Reihenfolge gelten schon. */
function slideList(){
  return workingImages.map(img => ({ src: img.url || img.dataUrl, name: img.name }));
}

document.getElementById("slideBtn").addEventListener("click", () => Diashow.open(slideList()));

/* ---- Lightbox ---- */
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");

function closeImageLightbox(){
  imageLightbox.hidden = true;
  imageLightboxImg.src = "data:,";
}

function openImageLightbox(key){
  const img = workingImages.find(i => i.key === key);
  if(!img) return;
  imageLightboxImg.src = img.url || img.dataUrl;
  imageLightboxImg.alt = img.name;
  imageLightbox.hidden = false;
}

imageListEl.addEventListener("dblclick", (e) => {
  if(!e.target.closest(".image-thumb img")) return;
  openImageLightbox(e.target.closest(".image-thumb").dataset.key);
});
imageLightbox.addEventListener("click", closeImageLightbox);
document.getElementById("imageLightboxClose").addEventListener("click", (e) => { e.stopPropagation(); closeImageLightbox(); });
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && !imageLightbox.hidden) closeImageLightbox();
});

/* ---- Bilder neu anordnen: Kontextmenue und Ziehen ----
   Die Reihenfolge der Liste ist die gespeicherte Reihenfolge (Spalte
   images.position); sie wird wie alles andere mit "Speichern" gesichert. */

/** Bild von Platz `from` an Platz `to` verschieben (Indizes in der neuen Liste). */
function moveImage(key, to){
  const from = workingImages.findIndex(i => i.key === key);
  if(from < 0) return;
  to = Math.max(0, Math.min(workingImages.length - 1, to));
  if(to === from) return;
  const [img] = workingImages.splice(from, 1);
  workingImages.splice(to, 0, img);
  imagesReordered(key, `Bild an Platz ${to + 1} verschoben`);
}

/** Alle Bilder sortieren. Ohne Zeit (noch nicht gespeichert) kommen ans Ende. */
function sortImages(mode){
  const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
  const list = workingImages.map((img, pos) => ({ img, pos, t: imageTime(img) }));
  const byTime = (dir) => (a, b) => {
    if(a.t === null || b.t === null) return (a.t === null) - (b.t === null) || a.pos - b.pos;
    return dir * (a.t - b.t) || a.pos - b.pos;
  };
  const byName = (dir) => (a, b) => dir * collator.compare(a.img.name, b.img.name) || a.pos - b.pos;
  const sorters = {
    "time-asc": [byTime(1), "älteste zuerst"],
    "time-desc": [byTime(-1), "neueste zuerst"],
    "name-asc": [byName(1), "Name A–Z"],
    "name-desc": [byName(-1), "Name Z–A"]
  };
  const [cmp, label] = sorters[mode];
  const sorted = list.sort(cmp).map(x => x.img);
  const changed = sorted.some((img, i) => img !== workingImages[i]);
  workingImages = sorted;
  if(changed) imagesReordered(null, `Bilder sortiert (${label})`);
  else showStatus(`Die Bilder sind schon so sortiert (${label}).`, "info");
}

function imagesReordered(focusKey, message){
  dirty = true;
  renderImageList(focusKey);
  showStatus(`${message} – mit „Speichern“ in der Reise sichern.`, "success");
}

/* Kontextmenue: Rechtsklick, Taste "Kontextmenü"/Umschalt+F10 oder Knopf "⋯" */
const imageMenu = document.createElement("div");
imageMenu.className = "image-context-menu";
imageMenu.setAttribute("role", "menu");
imageMenu.setAttribute("aria-label", "Bild");
imageMenu.hidden = true;
document.body.appendChild(imageMenu);
let imageMenuKey = null;

function openImageMenu(key, x, y){
  const pos = workingImages.findIndex(i => i.key === key);
  if(pos < 0) return;
  const last = workingImages.length - 1;
  const img = workingImages[pos];
  const item = (action, label, disabled = false) =>
    `<button type="button" role="menuitem" data-menu="${action}"${disabled ? " disabled" : ""}>${label}</button>`;
  const head = (label) => `<div class="image-context-head" role="presentation">${label}</div>`;
  let html = item("zoom", "🔍 Vergrössern");
  if(!readOnly){
    html += head("Neu anordnen")
      + item("first", "⇤ An den Anfang", pos === 0)
      + item("prev", "← Einen Platz nach vorne", pos === 0)
      + item("next", "→ Einen Platz nach hinten", pos === last)
      + item("last", "⇥ Ans Ende", pos === last)
      + head("Alle Bilder sortieren")
      + item("time-asc", "Älteste zuerst", last < 1)
      + item("time-desc", "Neueste zuerst", last < 1)
      + item("name-asc", "Name A–Z", last < 1)
      + item("name-desc", "Name Z–A", last < 1)
      + `<div class="image-context-sep" role="separator"></div>`
      + (isEditableDrawing(img) ? item("edit", "✎ Zeichenblatt bearbeiten") : "")
      + item("remove", "✕ Bild entfernen");
  }
  imageMenu.innerHTML = html;
  imageMenuKey = key;
  imageMenu.hidden = false;
  // Im Fenster halten
  const w = imageMenu.offsetWidth, h = imageMenu.offsetHeight;
  imageMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  imageMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  imageMenu.querySelector("button:not(:disabled)")?.focus();
}

function closeImageMenu(refocus){
  if(imageMenu.hidden) return;
  imageMenu.hidden = true;
  const key = imageMenuKey;
  imageMenuKey = null;
  if(refocus && key) imageListEl.querySelector(`.image-thumb[data-key="${CSS.escape(key)}"]`)?.focus();
}

imageListEl.addEventListener("contextmenu", (e) => {
  const thumb = e.target.closest(".image-thumb");
  if(!thumb) return;
  e.preventDefault();
  // Mit der Tastatur geoeffnet (clientX/Y = 0): Menue am Bild ausrichten
  let x = e.clientX, y = e.clientY;
  if(!x && !y){ const r = thumb.getBoundingClientRect(); x = r.left + 12; y = r.top + 12; }
  openImageMenu(thumb.dataset.key, x, y);
});

imageListEl.addEventListener("click", (e) => {
  const btn = e.target.closest('button[data-action="image-menu"]');
  if(!btn) return;
  e.stopPropagation();
  const r = btn.getBoundingClientRect();
  openImageMenu(btn.closest(".image-thumb").dataset.key, r.left, r.bottom + 4);
});

imageMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-menu]");
  if(!btn || btn.disabled) return;
  const key = imageMenuKey;
  const pos = workingImages.findIndex(i => i.key === key);
  const action = btn.dataset.menu;
  closeImageMenu(action === "zoom");
  if(pos < 0) return;
  switch(action){
    case "zoom": openImageLightbox(key); break;
    case "first": moveImage(key, 0); break;
    case "prev": moveImage(key, pos - 1); break;
    case "next": moveImage(key, pos + 1); break;
    case "last": moveImage(key, workingImages.length - 1); break;
    case "edit": imageListEl.querySelector(`.image-thumb[data-key="${CSS.escape(key)}"] [data-action="edit-drawing"]`)?.click(); break;
    case "remove": imageListEl.querySelector(`.image-thumb[data-key="${CSS.escape(key)}"] [data-action="remove-image"]`)?.click(); break;
    default: sortImages(action);
  }
});

imageMenu.addEventListener("keydown", (e) => {
  const items = [...imageMenu.querySelectorAll("button:not(:disabled)")];
  const i = items.indexOf(document.activeElement);
  if(e.key === "ArrowDown" || e.key === "ArrowUp"){
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length]?.focus();
  }else if(e.key === "Home"){ e.preventDefault(); items[0]?.focus(); }
  else if(e.key === "End"){ e.preventDefault(); items[items.length - 1]?.focus(); }
  else if(e.key === "Escape" || e.key === "Tab"){ e.preventDefault(); closeImageMenu(true); }
});

document.addEventListener("pointerdown", (e) => { if(!imageMenu.contains(e.target)) closeImageMenu(false); });
window.addEventListener("resize", () => closeImageMenu(false));
document.addEventListener("scroll", () => closeImageMenu(false), true);

/* Tastatur am Bild: Enter vergroessert, Alt+Pfeil verschiebt, Pos1/Ende mit Alt an Anfang/Ende */
imageListEl.addEventListener("keydown", (e) => {
  const thumb = e.target.closest(".image-thumb");
  if(!thumb || e.target !== thumb) return;
  const key = thumb.dataset.key;
  const pos = workingImages.findIndex(i => i.key === key);
  if(e.key === "Enter"){ e.preventDefault(); openImageLightbox(key); return; }
  if(readOnly || !e.altKey) return;
  const target = { ArrowLeft: pos - 1, ArrowUp: pos - 1, ArrowRight: pos + 1, ArrowDown: pos + 1, Home: 0, End: workingImages.length - 1 }[e.key];
  if(target === undefined) return;
  e.preventDefault();
  moveImage(key, target);
});

/* Ziehen und Ablegen. Eigener Datentyp, damit Dateien von aussen nicht stoeren. */
const DRAG_TYPE = "application/x-travelfy-image";
let dragKey = null;

function clearDropMarks(){
  imageListEl.querySelectorAll(".is-drop-before, .is-drop-after").forEach(el => el.classList.remove("is-drop-before", "is-drop-after"));
}

/** Einfuegeplatz (Index in der Liste ohne das gezogene Bild) und Markierung zum Zeiger. */
function dropTarget(e){
  const thumbs = [...imageListEl.querySelectorAll(".image-thumb")].filter(t => t.dataset.key !== dragKey);
  if(!thumbs.length) return { index: 0, thumb: null, after: false };
  // Naechstes Bild zum Zeiger; links/rechts der Mitte entscheidet vorher/nachher
  let best = null, bestDist = Infinity;
  for(const t of thumbs){
    const r = t.getBoundingClientRect();
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    const d = dx * dx + dy * dy * 4;    // Zeile zaehlt mehr als Spalte
    if(d < bestDist){ bestDist = d; best = t; }
  }
  const r = best.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  return { index: thumbs.indexOf(best) + (after ? 1 : 0), thumb: best, after };
}

imageListEl.addEventListener("dragstart", (e) => {
  const thumb = e.target.closest?.(".image-thumb");
  if(!thumb || readOnly){ return; }
  dragKey = thumb.dataset.key;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(DRAG_TYPE, dragKey);
  e.dataTransfer.setData("text/plain", "");
  closeImageMenu(false);
  // erst nach dem Erzeugen des Zieh-Bildes abdunkeln
  requestAnimationFrame(() => thumb.classList.add("is-dragging"));
});

imageListEl.addEventListener("dragover", (e) => {
  if(!dragKey || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const t = dropTarget(e);
  clearDropMarks();
  t.thumb?.classList.add(t.after ? "is-drop-after" : "is-drop-before");
});

imageListEl.addEventListener("dragleave", (e) => {
  if(!imageListEl.contains(e.relatedTarget)) clearDropMarks();
});

imageListEl.addEventListener("drop", (e) => {
  if(!dragKey || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
  e.preventDefault();
  const key = dragKey;
  const { index } = dropTarget(e);
  clearDropMarks();
  moveImage(key, index);
});

imageListEl.addEventListener("dragend", () => {
  dragKey = null;
  clearDropMarks();
  imageListEl.querySelectorAll(".is-dragging").forEach(el => el.classList.remove("is-dragging"));
});

/* ---- Rechte: Rolle + Ampel ---- */
let loadedTrip = null;

/** Felder sperren oder freigeben - beim Laden und bei jedem Wechsel der Ampel. */
function applyAccess(){
  readOnly = !canWrite();
  tripForm.classList.toggle("is-readonly", readOnly);
  tripForm.querySelectorAll("input, textarea, select").forEach(el => { el.disabled = readOnly; });
  cancelBtn.textContent = readOnly ? "Schliessen" : "Abbrechen";
  saveTripBtn.hidden = readOnly;
  deleteTripBtn.hidden = readOnly || !loadedTrip;
  if(loadedTrip){
    const hint = !currentUser.canWrite ? " – du hast nur Leserechte."
      : viewOnly ? " – Ampel Rot: nur Sicht." : ".";
    tripOwnerInfo.textContent = `Erfasst von ${loadedTrip.createdByName || "unbekannt"}${hint}`;
    tripOwnerInfo.hidden = false;
  }
  renderCategoryList();
  renderStationList();
  renderImageList();   // Ziehen/Menue folgen den Rechten
  closeImageMenu(false);
}

/* Ampel umgeschaltet. Auf Rot gehen ungespeicherte Aenderungen verloren -
   vorher nachfragen; eine neue Reise laesst sich bei Rot nicht anlegen. */
beforeViewModeChange = (nextViewOnly) => {
  if(!nextViewOnly || !dirty) return true;
  return window.confirm("Auf Rot (nur Sicht) schalten? Ungespeicherte Änderungen gehen verloren.");
};

document.addEventListener("travelfy:modus", () => {
  if(viewOnly && !tripId){ dirty = false; backToOverview(); return; }
  if(viewOnly && dirty){
    // Verworfene Aenderungen: gespeicherten Stand neu laden (Ampel bleibt Rot).
    dirty = false;
    leaving = true;
    window.location.reload();
    return;
  }
  applyAccess();
});

/* ---- Formular fuellen ---- */
function fillForm(trip, categoryOptions){
  loadedTrip = trip;
  categoryOptionsList.innerHTML = categoryOptions.map(c => `<option value="${escapeHtml(c)}"></option>`).join("");

  if(trip){
    detailHeading.textContent = trip.name;
    document.title = `Travelfy – ${trip.name}`;
    tripNameInput.value = trip.name;
    tripShortDescInput.value = trip.shortDesc || "";
    tripDestinationInput.value = trip.destination || "";
    tripStartDateInput.value = trip.startDate || "";
    tripEndDateInput.value = trip.endDate || "";
    tripLongTextInput.value = trip.longText || "";
    workingCategories = (trip.categories || []).map(name => ({ key: makeId(), name }));
    workingStations = (trip.stations || []).map(s => ({ key: s.id || makeId(), name: s.name, note: s.note || "" }));
    workingImages = (trip.images || []).map(i => ({ key: i.id, id: i.id, name: i.name, url: i.url, hasScene: !!i.hasScene, createdAt: i.createdAt || undefined }));
  }else{
    detailHeading.textContent = "Neue Reise";
    document.title = "Travelfy – Neue Reise";
  }
  applyAccess();
  renderImageList();
  dirty = false;
  if(!readOnly) tripNameInput.focus();
}

/* ---- Speichern ---- */
tripForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(readOnly) return;
  if(!tripNameInput.value.trim()){
    showStatus("Bitte einen Reisenamen eingeben.", "error");
    tripNameInput.focus();
    return;
  }
  if(stationNoteInput.value.trim() && !stationNameInput.value.trim()){
    showStatus("Zur eingetippten Notiz fehlt noch der Ort der Station.", "error");
    stationNameInput.focus();
    return;
  }
  if(tripStartDateInput.value && tripEndDateInput.value && tripEndDateInput.value < tripStartDateInput.value){
    showStatus("Das Enddatum liegt vor dem Startdatum.", "error");
    tripEndDateInput.focus();
    return;
  }

  saveTripBtn.disabled = true;
  saveTripBtn.textContent = "Speichert…";
  // Eingetippt, aber noch nicht hinzugefuegt: trotzdem mitspeichern.
  takePendingCategory();
  takePendingStation();
  await Promise.all(pendingImageReads);
  await uploadQueue;     // laufende Sofort-Speicherungen abwarten (sonst doppelt)

  const payload = tripPayload();

  const ok = await guard(async () => {
    if(tripId) await API.put(`/trips/${enc(tripId)}`, payload);
    else await API.post("/trips", payload);
  });
  if(ok){
    dirty = false;
    flashStatus(`Reise „${payload.name}" gespeichert.`);
    backToOverview();
    return;
  }
  saveTripBtn.disabled = false;
  saveTripBtn.textContent = "Speichern";
});

/* ---- Loeschen ---- */
deleteTripBtn.addEventListener("click", async () => {
  if(!tripId) return;
  if(!window.confirm(`Reise "${tripNameInput.value}" unwiderruflich löschen?`)) return;
  const ok = await guard(() => API.del(`/trips/${enc(tripId)}`));
  if(ok){
    dirty = false;
    flashStatus("Reise gelöscht.");
    backToOverview();
  }
});

/* =========================================================================
   Start
   ========================================================================= */
(async function init(){
  const user = await requireUser();
  if(!user) return;
  // Nur-lesen-Benutzer koennen keine neue Reise anlegen.
  // Neue Reise nur mit Schreibrecht und Ampel auf Gruen.
  if(!tripId && !canWrite()){ backToOverview(); return; }

  let trip = null;
  let state = { categoryOptions: [] };
  const ok = await guard(async () => {
    [trip, state] = await Promise.all([
      tripId ? API.get(`/trips/${enc(tripId)}`) : Promise.resolve(null),
      API.get("/state"),
    ]);
  });
  if(!ok) return;
  document.getElementById("appMain").hidden = false;
  fillForm(trip, state.categoryOptions);
})();
