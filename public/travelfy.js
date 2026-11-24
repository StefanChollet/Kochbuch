"use strict";

/* =========================================================================
   Uebersicht der Reisen — Tabelle mit Suche, Sortierung, Filtern und
   Lazy Loading (wie die Rezeptliste im Kochbuch). Ein Klick auf eine Reise
   oeffnet ihre Detailseite (reise.html?id=...).
   ========================================================================= */
const tripTableBody = document.getElementById("tripTableBody");
const tripEmptyState = document.getElementById("tripEmptyState");
const tripSearchInput = document.getElementById("tripSearchInput");
const tripSortSelect = document.getElementById("tripSortSelect");
const tripPagerInfo = document.getElementById("tripPagerInfo");
const tripTableScroll = document.getElementById("tripTableScroll");
const tripLoadMore = document.getElementById("tripLoadMore");
const tripCategoryFilter = document.getElementById("tripCategoryFilter");
const tripOwnerFilter = document.getElementById("tripOwnerFilter");
const tripOwnerFilterWrap = document.getElementById("tripOwnerFilterWrap");
const upcomingList = document.getElementById("upcomingList");
const upcomingEmptyState = document.getElementById("upcomingEmptyState");

const TRIP_BATCH_SIZE = 25;
const TRIP_PRELOAD_PX = 300;
const DEFAULT_TRIP_QUERY = { search: "", category: "", createdBy: "", sortBy: "name", sortDir: "asc" };
const tripQuery = { ...DEFAULT_TRIP_QUERY };
// Suche, Filter und Sortierung bleiben beim Wechsel Detail <-> Uebersicht erhalten.
const QUERY_KEY = "travelfy_query";

let tripsPage = { items: [], total: 0, page: 0, pageSize: TRIP_BATCH_SIZE, totalPages: 1 };
let tripLoadGeneration = 0;
let tripLoading = false;

function fetchTripsPage(query, page, pageSize){
  const params = new URLSearchParams();
  if(query.search) params.set("search", query.search);
  if(query.category) params.set("category", query.category);
  if(query.createdBy) params.set("createdBy", query.createdBy);
  params.set("sortBy", query.sortBy || "name");
  params.set("sortDir", query.sortDir || "asc");
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return API.get(`/trips?${params.toString()}`);
}

function saveQuery(){
  try{ window.sessionStorage.setItem(QUERY_KEY, JSON.stringify(tripQuery)); }catch{ /* egal */ }
}

function restoreQuery(){
  try{
    const saved = JSON.parse(window.sessionStorage.getItem(QUERY_KEY) || "null");
    if(saved && typeof saved === "object"){
      for(const key of Object.keys(DEFAULT_TRIP_QUERY)){
        if(typeof saved[key] === "string") tripQuery[key] = saved[key];
      }
    }
  }catch{ /* egal */ }
  tripSearchInput.value = tripQuery.search;
  const sortValue = `${tripQuery.sortBy}-${tripQuery.sortDir}`;
  tripSortSelect.value = [...tripSortSelect.options].some(o => o.value === sortValue) ? sortValue : "name-asc";
}

async function loadTrips({ keepLoaded = false } = {}){
  const generation = ++tripLoadGeneration;
  saveQuery();
  refreshTripFilters();
  const pages = keepLoaded ? Math.max(1, tripsPage.page) : 1;
  const scrollTop = keepLoaded ? tripTableScroll.scrollTop : 0;
  tripLoading = true;
  updateTripFooter();

  let result = null;
  const ok = await guard(async () => {
    let items = [];
    let last = null;
    for(let page = 1; page <= pages; page++){
      const next = await fetchTripsPage(tripQuery, page, TRIP_BATCH_SIZE);
      if(generation !== tripLoadGeneration) return;
      if(next.page !== page) break;
      items = items.concat(next.items);
      last = next;
      if(page >= next.totalPages) break;
    }
    result = { ...last, items };
  });
  if(generation !== tripLoadGeneration) return;

  tripLoading = false;
  if(ok && result) tripsPage = result;
  renderTripTable();
  tripTableScroll.scrollTop = scrollTop;
  if(ok) fillTripViewport();
}

async function loadMoreTrips(){
  const { page, totalPages } = tripsPage;
  if(tripLoading || page === 0 || page >= totalPages) return;
  const generation = tripLoadGeneration;
  tripLoading = true;
  updateTripFooter();

  let added = [];
  const ok = await guard(async () => {
    const next = await fetchTripsPage(tripQuery, page + 1, TRIP_BATCH_SIZE);
    if(generation !== tripLoadGeneration || next.page !== page + 1) return;
    const known = new Set(tripsPage.items.map(t => t.id));
    added = next.items.filter(t => !known.has(t.id));
    tripsPage = { ...next, items: tripsPage.items.concat(added) };
  });
  if(generation !== tripLoadGeneration) return;

  tripLoading = false;
  added.forEach(appendTripRow);
  updateTripFooter();
  if(ok) fillTripViewport();
}

function fillTripViewport(){
  const el = tripTableScroll;
  if(el.offsetParent === null) return;
  if(el.scrollHeight - el.scrollTop - el.clientHeight < TRIP_PRELOAD_PX) loadMoreTrips();
}

new IntersectionObserver((entries) => {
  if(entries.some(e => e.isIntersecting)) loadMoreTrips();
}, { root: tripTableScroll, rootMargin: `0px 0px ${TRIP_PRELOAD_PX}px 0px` }).observe(tripLoadMore);

function imageIndicator(trip){
  const has = trip.imageCount > 0;
  const label = has ? (trip.imageCount === 1 ? "1 Bild" : `${trip.imageCount} Bilder`) : "Keine Bilder";
  return `<svg class="trip-img-icon ${has ? "has-image" : "no-image"}" width="16" height="16" role="img" aria-label="${label}"><title>${label}</title><use href="#reisebild"/></svg>`;
}

function tripActions(trip){
  const btn = (action, icon, label) =>
    `<button class="btn btn-icon menu-icon-btn menu-icon-${icon}" data-action="${action}" data-id="${escapeHtml(trip.id)}" title="${label}" aria-label="${label}">` +
    `<svg width="16" height="16" aria-hidden="true"><use href="#icon-${icon}"/></svg></button>`;
  return canWrite()
    ? btn("open", "edit", "Bearbeiten") + btn("delete", "delete", "Löschen")
    : btn("open", "view", "Ansehen");
}

function appendTripRow(trip){
  const tr = document.createElement("tr");
  tr.dataset.id = trip.id;
  tr.tabIndex = 0;
  tr.title = canWrite() ? "Reise öffnen und bearbeiten" : "Reise ansehen";
  const sub = [trip.category ? `<span class="category-chip">${escapeHtml(trip.category)}</span>` : "", truncate(trip.shortDesc, 80)]
    .filter(Boolean).join(" ");
  tr.innerHTML = `
    <td class="trip-name-cell">
      <span class="trip-name-line">${imageIndicator(trip)}${escapeHtml(trip.name)}</span>
      ${sub ? `<span class="trip-name-sub">${sub}</span>` : ""}
    </td>
    <td class="dest-cell col-dest">${escapeHtml(trip.destination || "–")}</td>
    <td class="date-cell">${escapeHtml(formatRange(trip.startDate, trip.endDate) || "–")}</td>
    <td class="owner-cell">${escapeHtml(trip.createdByName || "–")}</td>
    <td class="menu-cell">${tripActions(trip)}</td>
  `;
  tripTableBody.appendChild(tr);
}

function renderTripTable(){
  const { items } = tripsPage;
  const filtered = tripQuery.search.trim().length > 0 || !!tripQuery.category || !!tripQuery.createdBy;
  tripTableBody.innerHTML = "";
  tripEmptyState.hidden = items.length > 0 || tripLoading;
  tripEmptyState.textContent = filtered
    ? (tripQuery.search.trim() ? `Keine Reisen gefunden für "${tripQuery.search.trim()}".` : "Keine Reisen für diesen Filter.")
    : canWrite() ? 'Noch keine Reisen erfasst. Leg mit "Reise erfassen" los.' : "Noch keine Reisen erfasst.";
  items.forEach(appendTripRow);
  updateTripFooter();
}

function updateTripFooter(){
  const { items, total, page, totalPages } = tripsPage;
  tripPagerInfo.textContent = total === 0
    ? (tripLoading ? "" : "Keine Reisen")
    : items.length >= total
      ? (total === 1 ? "1 Reise" : `Alle ${total} Reisen geladen`)
      : `${items.length} von ${total} Reisen geladen – weiterscrollen für mehr`;
  const more = page > 0 && page < totalPages;
  tripLoadMore.textContent = tripLoading ? "Reisen werden geladen…" : more ? "Weitere Reisen…" : "";
  tripLoadMore.hidden = !tripLoading && !more;
}

/** Detailseite oeffnen - immer nur eine Travelfy-Seite, nie eine fremde Adresse. */
function openTrip(id){
  window.location.href = id ? `reise.html?id=${enc(id)}` : "reise.html";
}

tripTableBody.addEventListener("keydown", (e) => {
  if(e.key !== "Enter" || !e.target.matches("tr[data-id]")) return;
  e.preventDefault();
  openTrip(e.target.dataset.id);
});

tripTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if(!btn){
    const tr = e.target.closest("tr[data-id]");
    if(tr) openTrip(tr.dataset.id);
    return;
  }
  const id = btn.dataset.id;
  if(btn.dataset.action === "open"){ openTrip(id); return; }
  if(btn.dataset.action === "delete"){
    const trip = tripsPage.items.find(t => t.id === id);
    if(!window.confirm(`Reise "${trip ? trip.name : ""}" unwiderruflich löschen?`)) return;
    await guard(async () => {
      await API.del(`/trips/${enc(id)}`);
      await Promise.all([loadTrips({ keepLoaded: true }), loadUpcoming()]);
    }, { success: "Reise gelöscht." });
  }
});

document.getElementById("createTripBtn").addEventListener("click", () => openTrip(null));

/* ---- Suche (debounced, Enter loest sofort aus) ---- */
let tripSearchTimer = null;
tripSearchInput.addEventListener("input", () => {
  clearTimeout(tripSearchTimer);
  tripSearchTimer = setTimeout(() => {
    tripQuery.search = tripSearchInput.value;
    loadTrips();
  }, 300);
});
tripSearchInput.addEventListener("keydown", (e) => {
  if(e.key !== "Enter") return;
  clearTimeout(tripSearchTimer);
  tripQuery.search = tripSearchInput.value;
  loadTrips();
});

/* ---- Filter Reiseart / Benutzer ---- */
async function refreshTripFilters(){
  let filters;
  try{
    filters = await API.get("/trip-filters");
  }catch(err){
    console.warn("Filter konnten nicht geladen werden:", err);
    return;
  }
  const opt = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;

  const categories = [...filters.categories];
  const cat = tripQuery.category;
  if(cat && cat !== "-" && !categories.some(c => c.toLowerCase() === cat.toLowerCase())) categories.push(cat);
  tripCategoryFilter.innerHTML = opt("", "Alle Reisearten") +
    categories.map(c => opt(c, c)).join("") +
    (filters.withoutCategory || cat === "-" ? opt("-", "– ohne Reiseart –") : "");
  tripCategoryFilter.value = cat;

  const owners = [...filters.owners];
  const own = tripQuery.createdBy;
  if(own && !owners.some(o => String(o.id) === own)) owners.push({ id: own, username: "(unbekannt)" });
  tripOwnerFilter.innerHTML = opt("", "Alle Benutzer") + owners.map(o => opt(String(o.id), o.username)).join("");
  tripOwnerFilter.value = own;
  // Wer nur die eigenen Reisen sieht, braucht keinen Benutzer-Filter.
  tripOwnerFilterWrap.hidden = !own && (currentUser && currentUser.role === "rw");
  markActiveFilters();
}

function markActiveFilters(){
  tripCategoryFilter.classList.toggle("is-active", !!tripQuery.category);
  tripOwnerFilter.classList.toggle("is-active", !!tripQuery.createdBy);
}

tripCategoryFilter.addEventListener("change", () => {
  tripQuery.category = tripCategoryFilter.value;
  markActiveFilters();
  loadTrips();
});
tripOwnerFilter.addEventListener("change", () => {
  tripQuery.createdBy = tripOwnerFilter.value;
  markActiveFilters();
  loadTrips();
});

tripSortSelect.addEventListener("change", () => {
  const [sortBy, sortDir] = tripSortSelect.value.split("-");
  tripQuery.sortBy = sortBy;
  tripQuery.sortDir = sortDir;
  loadTrips();
});

document.getElementById("tripResetFiltersBtn").addEventListener("click", () => {
  clearTimeout(tripSearchTimer);
  Object.assign(tripQuery, DEFAULT_TRIP_QUERY);
  tripSearchInput.value = "";
  tripSortSelect.value = "name-asc";
  tripCategoryFilter.value = "";
  tripOwnerFilter.value = "";
  markActiveFilters();
  loadTrips();
});

/* =========================================================================
   Seitenleiste "Naechste Reisen": die fuenf naechsten ab heute.
   ========================================================================= */
function daysUntil(iso){
  const [y, m, d] = iso.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((start - today) / 86400000);
}

async function loadUpcoming(){
  const params = new URLSearchParams({ fromDate: todayIso(), sortBy: "startDate", sortDir: "asc", page: "1", pageSize: "5" });
  let data;
  try{
    data = await API.get(`/trips?${params.toString()}`);
  }catch(err){
    console.warn("Nächste Reisen:", err);
    return;
  }
  upcomingEmptyState.hidden = data.items.length > 0;
  upcomingList.innerHTML = data.items.map(t => {
    const days = daysUntil(t.startDate);
    const countdown = days === 0 ? "heute" : days === 1 ? "morgen" : `in ${days} Tagen`;
    return `
      <li class="upcoming-item" data-id="${escapeHtml(t.id)}" tabindex="0" title="Reise öffnen">
        <span class="upcoming-name">${escapeHtml(t.name)}</span>
        <span class="upcoming-meta">${escapeHtml([t.destination, formatRange(t.startDate, t.endDate)].filter(Boolean).join(" · "))}</span>
        <span class="upcoming-countdown">${countdown}</span>
      </li>`;
  }).join("");
}

upcomingList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if(li) openTrip(li.dataset.id);
});
upcomingList.addEventListener("keydown", (e) => {
  const li = e.target.closest("li[data-id]");
  if(li && e.key === "Enter") openTrip(li.dataset.id);
});

/* =========================================================================
   Start
   ========================================================================= */
(async function init(){
  const user = await requireUser();
  if(!user) return;
  onUsersChanged = () => Promise.all([loadTrips({ keepLoaded: true }), loadUpcoming()]);
  // Ampel umgeschaltet: Bearbeiten/Loeschen bzw. Ansehen in jeder Zeile neu zeichnen.
  document.addEventListener("travelfy:modus", renderTripTable);
  document.getElementById("appMain").hidden = false;
  restoreQuery();
  showFlash();
  await Promise.all([loadTrips(), loadUpcoming()]);
})();
