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

const tripId = new URLSearchParams(window.location.search).get("id") || "";
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
function renderImageList(){
  imageListEl.innerHTML = workingImages.map(img => `
    <div class="image-thumb" data-key="${img.key}">
      <img src="${escapeHtml(img.url || img.dataUrl)}" alt="${escapeHtml(img.name)}" loading="lazy" title="Doppelklick: vergrößern">
      <button type="button" class="image-remove" data-action="remove-image" aria-label="Bild entfernen">✕</button>
    </div>
  `).join("");
}

imageListEl.addEventListener("click", (e) => {
  if(!e.target.closest('button[data-action="remove-image"]')) return;
  const wrap = e.target.closest(".image-thumb");
  workingImages = workingImages.filter(i => i.key !== wrap.dataset.key);
  dirty = true;
  renderImageList();
});

const pendingImageReads = new Set();

imageInput.addEventListener("change", () => {
  Array.from(imageInput.files || []).forEach(file => {
    const read = new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        workingImages.push({ key: makeId(), name: file.name, dataUrl: reader.result, isNew: true });
        dirty = true;
        renderImageList();
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

/* ---- Lightbox ---- */
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");

function closeImageLightbox(){
  imageLightbox.hidden = true;
  imageLightboxImg.src = "data:,";
}

imageListEl.addEventListener("dblclick", (e) => {
  const img = e.target.closest(".image-thumb img");
  if(!img) return;
  imageLightboxImg.src = img.src;
  imageLightboxImg.alt = img.alt;
  imageLightbox.hidden = false;
});
imageLightbox.addEventListener("click", closeImageLightbox);
document.getElementById("imageLightboxClose").addEventListener("click", (e) => { e.stopPropagation(); closeImageLightbox(); });
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && !imageLightbox.hidden) closeImageLightbox();
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
    workingImages = (trip.images || []).map(i => ({ key: i.id, id: i.id, name: i.name, url: i.url }));
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

  const payload = {
    name: tripNameInput.value.trim(),
    shortDesc: tripShortDescInput.value.trim(),
    destination: tripDestinationInput.value.trim(),
    startDate: tripStartDateInput.value,
    endDate: tripEndDateInput.value,
    longText: tripLongTextInput.value,
    categories: workingCategories.map(c => c.name),
    stations: workingStations.map(s => ({ name: s.name, note: s.note })),
    images: workingImages.map(img => img.isNew
      ? { name: img.name, dataUrl: img.dataUrl }
      : { id: img.id, name: img.name })
  };

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
