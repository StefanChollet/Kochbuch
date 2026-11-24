"use strict";

/* =========================================================================
   Travelfy – gemeinsamer Teil aller Seiten (Uebersicht, Detail, Anmeldung):
   Server-Zugriff, Statuszeile, Hell/Dunkel, Kopfzeile mit Benutzermenue,
   Benutzerverwaltung und Passwort-Dialog.
   ========================================================================= */

/* ---- Unterpfad ----
   Travelfy laeuft unter einem Unterpfad (auf trex: /travelfy/). Alle Seiten
   liegen direkt darin, darum ist ihr Verzeichnis die Basis der App. Alle
   Adressen in Travelfy sind relativ dazu ("api/...", "reise.html"). */
const APP_BASE = new URL("./", window.location.href).pathname;   // z.B. "/travelfy/"

/** Pfad der aktuellen Seite relativ zur App, z.B. "reise.html?id=..." */
function currentAppPage(){
  return window.location.pathname.slice(APP_BASE.length) + window.location.search;
}

/* ---- Sprung-Sperre im Browser ----
   Travelfy fuehrt nirgendwo anders hin: Links auf eine andere Herkunft
   oder auf einen anderen Pfad desselben Hosts (z.B. /kochbuch/) werden nicht
   geoeffnet. Der Server sperrt zusaetzlich alles, was von aussen hereinkommt. */
function isOwnUrl(href){
  try{
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith(APP_BASE);
  }catch{ return false; }
}

document.addEventListener("click", (e) => {
  const link = e.target.closest && e.target.closest("a[href]");
  if(!link || isOwnUrl(link.href)) return;
  e.preventDefault();
  e.stopPropagation();
  showStatus("Travelfy öffnet keine anderen Anwendungen.", "error");
}, true);

// Fenster einer anderen App, die Travelfy geoeffnet hat, bekommt keinen Griff darauf.
try{ if(window.opener) window.opener = null; }catch{ /* egal */ }

/* =========================================================================
   API — Zugriff auf den Server (REST, JSON).
   ========================================================================= */
const API = {
  base: "api",   // relativ: /travelfy/api/...

  async request(method, path, body){
    let res;
    try{
      res = await fetch(this.base + path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }catch(err){
      throw new Error("Keine Verbindung zum Travelfy-Server – bitte Internetverbindung prüfen.");
    }

    if(res.status === 204) return null;

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const payload = isJson ? await res.json() : await res.text();

    // Sitzung abgelaufen oder abgemeldet: zur Anmeldung (ausser bei Login/Passwort selbst).
    if(res.status === 401 && !path.startsWith("/auth/")){
      goToLogin();
      throw new Error("Bitte anmelden.");
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

function makeId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML.replace(/"/g, "&quot;");
}

function truncate(str, max){
  if(!str) return "";
  if(str.length <= max) return escapeHtml(str);
  return escapeHtml(str.slice(0, max - 1).trimEnd()) + "…";
}

/** "2026-07-14" -> "14.07.2026" */
function formatDate(iso){
  if(!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function formatRange(start, end){
  if(start && end) return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
  if(start) return `ab ${formatDate(start)}`;
  if(end) return `bis ${formatDate(end)}`;
  return "";
}

/** Heutiges Datum (lokal) als JJJJ-MM-TT. */
function todayIso(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---- Erlaubte Ziele nach der Anmeldung: nur Seiten von Travelfy selbst ---- */
// Relativ zur App: "", "index.html" oder "reise.html?id=..." - nie eine
// andere Adresse, nie eine andere App.
function safeNext(next){
  const value = String(next || "");
  if(/^(index\.html)?$/.test(value)) return "./";
  if(/^reise\.html(\?id=[A-Za-z0-9]{1,40})?$/.test(value)) return value;
  return "./";
}

function goToLogin(){
  if(currentAppPage().startsWith("login.html")) return;
  window.location.replace(`login.html?next=${enc(safeNext(currentAppPage()))}`);
}

/* =========================================================================
   Kopfzeile, Statuszeile und Dialoge – auf jeder Seite gleich.
   ========================================================================= */
const CHROME_HTML = `
<svg class="svg-sprite" aria-hidden="true" focusable="false">
  <defs>
    <!-- Logo: Papierflieger vor der Sonne -->
    <symbol id="logo" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill="#F5C518"/>
      <circle cx="16" cy="16" r="15" fill="none" stroke="#9C7400" stroke-width="1.5"/>
      <path d="M6 16.5 25.5 8l-5 16-5.2-4.6-3.3 3.6.4-5.6z" fill="#2D2915"/>
      <path d="M12.4 17.4 25.5 8l-10.2 11.4" fill="#6A6244"/>
    </symbol>
    <!-- Reisebild (16x16): Bild mit Sonne und Huegel, farbig = Reise hat Bilder -->
    <symbol id="reisebild" viewBox="0 0 16 16">
      <rect x="1" y="1.5" width="14" height="13" rx="2" fill="var(--reisebild-bg, none)" stroke="var(--reisebild-frame, currentColor)" stroke-width="1.2"/>
      <circle cx="11" cy="5.4" r="1.8" fill="var(--reisebild-sun, currentColor)"/>
      <path d="M2.2 13.3 6.3 7.8l3 3.6 1.7-1.8 2.8 3.7z" fill="var(--reisebild-hill, currentColor)"/>
    </symbol>
    <symbol id="icon-edit" viewBox="0 0 16 16">
      <path d="M10.8 2.2l3 3-8.3 8.3-3.6.6.6-3.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M9.3 3.7l3 3" stroke="currentColor" stroke-width="1.4"/>
    </symbol>
    <symbol id="icon-view" viewBox="0 0 16 16">
      <path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="8" cy="8" r="2.1" fill="currentColor"/>
    </symbol>
    <symbol id="icon-view-off" viewBox="0 0 16 16">
      <use href="#icon-view"/>
      <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </symbol>
    <symbol id="icon-delete" viewBox="0 0 16 16">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </symbol>
  </defs>
</svg>

<header class="app-header">
  <h1 class="app-title"><a href="./" title="Zur Übersicht"><svg aria-hidden="true"><use href="#logo"/></svg>Travelfy</a></h1>
  <div class="header-right">
    <button id="installBtn" class="btn btn-ghost btn-small" type="button" title="Travelfy als App auf diesem Gerät installieren" hidden>📲 App installieren</button>
    <div id="userBar" class="user-bar" hidden>
      <button id="userMenuBtn" class="user-menu-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="userMenu" title="Benutzermenü">
        <span class="user-name" id="currentUserName"></span>
        <span class="role-badge" id="currentUserRole"></span>
        <span class="user-menu-caret" aria-hidden="true">▾</span>
      </button>
      <div id="userMenu" class="user-menu" role="menu" hidden>
        <button id="usersBtn" class="user-menu-item" role="menuitem" type="button" hidden>Benutzerverwaltung</button>
        <button id="passwordBtn" class="user-menu-item" role="menuitem" type="button">Passwort ändern</button>
        <button id="logoutBtn" class="user-menu-item user-menu-logout" role="menuitem" type="button">Abmelden</button>
      </div>
    </div>
    <button id="themeToggle" class="btn btn-ghost" type="button" aria-label="Hell/Dunkel umschalten">
      <span id="themeIcon">🌙</span>
    </button>
  </div>
</header>

<p id="appStatus" class="app-status" role="status" aria-live="polite" hidden></p>

<dialog id="usersDialog" class="app-dialog users-dialog-wide">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2>Benutzerverwaltung</h2>
      <button type="button" class="btn btn-ghost" data-close aria-label="Schliessen">✕</button>
    </div>
    <p class="app-status dialog-status" role="status" aria-live="polite" hidden></p>
    <div class="trip-table-scroll">
      <table class="trip-table users-table">
        <thead>
          <tr><th>ID</th><th>Benutzername</th><th>Rechte</th><th>Reisen</th><th class="col-menu">Menu</th></tr>
        </thead>
        <tbody id="usersTableBody"></tbody>
      </table>
    </div>
    <form id="newUserForm">
      <fieldset class="field-group">
        <legend>Neuen Benutzer anlegen</legend>
        <div class="new-user-row">
          <input type="text" id="newUserName" placeholder="Benutzername" required maxlength="40" autocomplete="off">
          <input type="password" id="newUserPassword" placeholder="Passwort (mind. 8 Zeichen)" required maxlength="200" autocomplete="new-password">
          <select id="newUserRole" aria-label="Rechte">
            <option value="r">Nur lesen</option>
            <option value="rw">Lesen + Schreiben</option>
          </select>
          <button type="submit" class="btn btn-primary btn-small">Anlegen</button>
        </div>
      </fieldset>
    </form>
  </div>
</dialog>

<dialog id="passwordDialog" class="app-dialog small-dialog">
  <form id="passwordForm" class="dialog-body" method="dialog">
    <div class="dialog-head">
      <h2>Passwort ändern</h2>
      <button type="button" class="btn btn-ghost" data-close aria-label="Schliessen">✕</button>
    </div>
    <label class="field" id="passwordUserField" hidden>
      <span>Benutzer</span>
      <select id="passwordUser"></select>
    </label>
    <label class="field">
      <span id="currentPasswordLabel">Bisheriges Passwort</span>
      <span class="pw-wrap">
        <input type="password" id="currentPassword" required autocomplete="current-password" maxlength="200">
        <button type="button" class="pw-toggle" aria-label="Passwort anzeigen" title="Passwort anzeigen"><svg width="16" height="16" aria-hidden="true"><use href="#icon-view"/></svg></button>
      </span>
    </label>
    <label class="field">
      <span>Neues Passwort (mind. 8 Zeichen)</span>
      <span class="pw-wrap">
        <input type="password" id="newPassword" required autocomplete="new-password" maxlength="200">
        <button type="button" class="pw-toggle" aria-label="Passwort anzeigen" title="Passwort anzeigen"><svg width="16" height="16" aria-hidden="true"><use href="#icon-view"/></svg></button>
      </span>
    </label>
    <label class="field">
      <span>Neues Passwort wiederholen</span>
      <span class="pw-wrap">
        <input type="password" id="newPasswordRepeat" required autocomplete="new-password" maxlength="200">
        <button type="button" class="pw-toggle" aria-label="Passwort anzeigen" title="Passwort anzeigen"><svg width="16" height="16" aria-hidden="true"><use href="#icon-view"/></svg></button>
      </span>
    </label>
    <p id="passwordError" class="form-error" hidden></p>
    <div class="dialog-actions">
      <button type="button" class="btn btn-ghost" data-close>Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>
</dialog>
`;

document.body.insertAdjacentHTML("afterbegin", CHROME_HTML);

/* =========================================================================
   Statusmeldungen — eine Zeile unter dem Header.
   ========================================================================= */
const statusBar = document.getElementById("appStatus");
let statusTimer = null;

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

/** Meldung fuer die naechste Seite merken (z.B. "Reise gespeichert" nach dem Zurueckspringen). */
function flashStatus(message, kind = "success"){
  try{ window.sessionStorage.setItem("travelfy_flash", JSON.stringify({ message, kind })); }catch{ /* egal */ }
}

function showFlash(){
  try{
    const raw = window.sessionStorage.getItem("travelfy_flash");
    if(!raw) return;
    window.sessionStorage.removeItem("travelfy_flash");
    const { message, kind } = JSON.parse(raw);
    showStatus(message, kind);
  }catch{ /* egal */ }
}

async function guard(action, { success } = {}){
  try{
    await action();
    if(success) showStatus(success, "success");
    return true;
  }catch(err){
    console.error("Travelfy:", err);
    showStatus(err.message, "error");
    return false;
  }
}

document.querySelectorAll("dialog").forEach(dialog => {
  dialog.addEventListener("close", () => {
    if(dialog.open) return;
    dialog.querySelectorAll(".dialog-status").forEach(el => { el.hidden = true; });
  });
});
document.querySelectorAll("dialog [data-close]").forEach(btn => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
});

/* =========================================================================
   Theme — Anzeigeeinstellung pro Geraet (localStorage, nur fuer Travelfy).
   ========================================================================= */
const themeIcon = document.getElementById("themeIcon");

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.textContent = theme === "dark" ? "☀️" : "🌙";
  try{ window.localStorage.setItem("travelfy_theme", theme); }catch{ /* egal */ }
}

(function initTheme(){
  let saved = null;
  try{ saved = window.localStorage.getItem("travelfy_theme"); }catch{ /* egal */ }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
})();

document.getElementById("themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

/* =========================================================================
   Benutzer und Rechte
   - admin (id 0): fest, einmalig; als einziger in der Benutzerverwaltung
   - rw: lesen und schreiben (sieht nur die eigenen Reisen)
   - r:  nur lesen (sieht alle Reisen)
   Der Server prueft jedes Recht selbst; hier geht es nur um die Anzeige.
   ========================================================================= */
const ROLE_LABELS = { admin: "Admin", rw: "Lesen + Schreiben", r: "Nur lesen" };
let currentUser = null;

function canWrite(){
  return !!currentUser && currentUser.canWrite;
}

const userBar = document.getElementById("userBar");
const userMenuBtn = document.getElementById("userMenuBtn");
const userMenu = document.getElementById("userMenu");

function setUserMenuOpen(open){
  userMenu.hidden = !open;
  userMenuBtn.setAttribute("aria-expanded", String(open));
  if(open) userMenu.querySelector(".user-menu-item:not([hidden])")?.focus();
}

userMenuBtn.addEventListener("click", () => setUserMenuOpen(userMenu.hidden));
userMenu.addEventListener("click", (e) => { if(e.target.closest(".user-menu-item")) setUserMenuOpen(false); });
document.addEventListener("click", (e) => {
  if(!userMenu.hidden && !e.target.closest("#userBar")) setUserMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && !userMenu.hidden){ setUserMenuOpen(false); userMenuBtn.focus(); }
});

function setCurrentUser(user){
  currentUser = user;
  document.getElementById("currentUserName").textContent = user.username;
  const role = document.getElementById("currentUserRole");
  role.textContent = ROLE_LABELS[user.role] || user.role;
  role.className = `role-badge role-${user.role}`;
  role.title = user.canWrite ? "Darf lesen und schreiben" : "Darf nur lesen";
  document.getElementById("usersBtn").hidden = user.role !== "admin";
  document.body.classList.toggle("is-readonly", !user.canWrite);
  userBar.hidden = false;
}

/**
 * Jede geschuetzte Seite startet hiermit: ohne Anmeldung geht es zur
 * Anmeldeseite (mit Ruecksprung auf genau diese Travelfy-Seite).
 */
async function requireUser(){
  let status;
  try{
    status = await API.get("/auth/status");
  }catch(err){
    showStatus(err.message, "error");
    return null;
  }
  if(!status.user){
    goToLogin();
    return null;
  }
  setCurrentUser(status.user);
  return status.user;
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await guard(() => API.post("/auth/logout"));
  currentUser = null;
  try{ ["travelfy_query", "travelfy_flash"].forEach(k => window.sessionStorage.removeItem(k)); }catch{ /* egal */ }
  window.location.replace("login.html");
});

/* ---- Benutzerverwaltung (nur Admin) ---- */
const usersDialog = document.getElementById("usersDialog");
const usersTableBody = document.getElementById("usersTableBody");
const newUserForm = document.getElementById("newUserForm");
let userList = [];
// Seiten koennen sich hier eintragen, um nach dem Loeschen eines Benutzers neu zu laden.
let onUsersChanged = null;

async function loadUsers(){
  userList = await API.get("/users");
  renderUsers();
}

function renderUsers(){
  usersTableBody.innerHTML = userList.map(u => {
    if(u.role === "admin"){
      return `
        <tr data-id="${u.id}">
          <td>${u.id}</td>
          <td>${escapeHtml(u.username)} <span class="owner-cell">(ich)</span></td>
          <td><span class="role-badge role-admin">${ROLE_LABELS.admin}</span></td>
          <td>${u.tripCount}</td>
          <td><span class="fixed-note">fest – nicht änderbar</span></td>
        </tr>`;
    }
    const opt = (v) => `<option value="${v}"${u.role === v ? " selected" : ""}>${ROLE_LABELS[v]}</option>`;
    return `
      <tr data-id="${u.id}">
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>
          <select data-action="role" aria-label="Rechte von ${escapeHtml(u.username)}">
            ${opt("rw")}${opt("r")}
          </select>
        </td>
        <td>${u.tripCount}</td>
        <td class="menu-cell">
          <button type="button" class="btn btn-icon" data-action="delete-user" title="Löschen" aria-label="Löschen">🗑️</button>
        </td>
      </tr>`;
  }).join("");
}

usersTableBody.addEventListener("change", async (e) => {
  if(e.target.dataset.action !== "role") return;
  const select = e.target;
  const user = userList.find(u => String(u.id) === select.closest("tr").dataset.id);
  const ok = await guard(async () => {
    await API.patch(`/users/${enc(user.id)}`, { role: select.value });
    await loadUsers();
  }, { success: `Rechte von ${user.username}: ${ROLE_LABELS[select.value]}.` });
  if(!ok) select.value = user.role;
});

usersTableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest('button[data-action="delete-user"]');
  if(!btn) return;
  const user = userList.find(u => String(u.id) === btn.closest("tr").dataset.id);
  const ok = window.confirm(
    `Benutzer "${user.username}" löschen?\n\n` +
    (user.tripCount > 0 ? `Seine ${user.tripCount} Reise(n) werden ebenfalls gelöscht.` : "Er hat keine Reisen erfasst.")
  );
  if(!ok) return;
  await guard(async () => {
    await API.del(`/users/${enc(user.id)}`);
    await loadUsers();
    if(onUsersChanged) await onUsersChanged();
  }, { success: `Benutzer ${user.username} und seine Reisen gelöscht.` });
});

newUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("newUserName").value.trim();
  const role = document.getElementById("newUserRole").value;
  await guard(async () => {
    await API.post("/users", { username, password: document.getElementById("newUserPassword").value, role });
    newUserForm.reset();
    await loadUsers();
  }, { success: `Benutzer ${username} angelegt (${ROLE_LABELS[role]}).` });
});

document.getElementById("usersBtn").addEventListener("click", async () => {
  await guard(async () => {
    await loadUsers();
    usersDialog.showModal();
  });
});

/* ---- Passwort aendern: jeder das eigene, der Admin auch das anderer Benutzer ---- */
const passwordDialog = document.getElementById("passwordDialog");
const passwordForm = document.getElementById("passwordForm");
const passwordError = document.getElementById("passwordError");
const passwordUserField = document.getElementById("passwordUserField");
const passwordUser = document.getElementById("passwordUser");
const currentPasswordLabel = document.getElementById("currentPasswordLabel");

function updatePasswordLabel(){
  const forOther = !passwordUserField.hidden && passwordUser.value !== String(currentUser.id);
  currentPasswordLabel.textContent = forOther ? "Dein Admin-Passwort zur Bestätigung" : "Bisheriges Passwort";
}

passwordUser.addEventListener("change", updatePasswordLabel);

function setPasswordVisible(toggle, visible){
  toggle.previousElementSibling.type = visible ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(visible));
  toggle.title = visible ? "Passwort verbergen" : "Passwort anzeigen";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.querySelector("use").setAttribute("href", visible ? "#icon-view-off" : "#icon-view");
}

passwordForm.querySelectorAll(".pw-toggle").forEach(toggle => {
  toggle.addEventListener("click", () => {
    setPasswordVisible(toggle, toggle.getAttribute("aria-pressed") !== "true");
    toggle.previousElementSibling.focus();
  });
});

document.getElementById("passwordBtn").addEventListener("click", async () => {
  passwordForm.reset();
  passwordForm.querySelectorAll(".pw-toggle").forEach(toggle => setPasswordVisible(toggle, false));
  passwordError.hidden = true;
  passwordUserField.hidden = currentUser.role !== "admin";
  if(!passwordUserField.hidden){
    const ok = await guard(async () => {
      const users = await API.get("/users");
      passwordUser.innerHTML = users.map(u =>
        `<option value="${u.id}">${escapeHtml(u.username)}${u.id === currentUser.id ? " (ich)" : ""}</option>`).join("");
      passwordUser.value = String(currentUser.id);
    });
    if(!ok) return;
  }
  updatePasswordLabel();
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
  const currentPassword = document.getElementById("currentPassword").value;
  const forOther = !passwordUserField.hidden && passwordUser.value !== String(currentUser.id);
  try{
    if(forOther){
      const user = await API.post(`/users/${enc(passwordUser.value)}/password`, { adminPassword: currentPassword, newPassword });
      passwordDialog.close();
      showStatus(`Neues Passwort für ${user.username} gesetzt.`, "success");
      return;
    }
    await API.post("/auth/password", { currentPassword, newPassword });
    passwordDialog.close();
    showStatus("Passwort geändert.", "success");
  }catch(err){
    passwordError.textContent = err.message;
    passwordError.hidden = false;
  }
});

/* =========================================================================
   PWA — Service Worker (nur App-Huelle, keine Daten) und "App installieren".
   ========================================================================= */
if("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service Worker:", err));
  });
}

const installBtn = document.getElementById("installBtn");
let installPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if(!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installBtn.hidden = true;
  showStatus("Travelfy als App installiert.", "success");
});
