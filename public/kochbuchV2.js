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
      const err = new Error((payload && payload.error) || `Serverfehler (HTTP ${res.status}).`);
      // "code" ist ein stabiler, uebersetzbarer Bezeichner (siehe db.js HttpError) -
      // fehlt er, bleibt es bei der (nur deutschen) message aus der API.
      if(payload && payload.code) err.code = payload.code;
      throw err;
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
   Sprache — de/fr/it/en. Deckt den Anmelde-Bereich ab (Widget, Dialog,
   Meldungen); die Rezeptdaten selbst bleiben unuebersetzt (Nutzerinhalte).
   ========================================================================= */
const I18N = {
  de: {
    guest: "Gast", stateOut: "Abgemeldet", stateIn: "Angemeldet", memberSince: "Mitglied seit",
    login: "Anmelden", logout: "Abmelden", register: "Konto eröffnen",
    loginTitle: "Anmelden", registerTitle: "Konto eröffnen", forgotTitle: "Passwort vergessen", resetTitle: "Neues Passwort setzen",
    loginTab: "Anmelden", registerTab: "Konto eröffnen",
    emailLabel: "E-Mail", passwordLabel: "Passwort", password2Label: "Passwort wiederholen",
    forgotLink: "Passwort vergessen?", backToLogin: "Zurück zur Anmeldung",
    cancel: "Abbrechen", submitLogin: "Anmelden", submitRegister: "Konto eröffnen",
    submitForgot: "Link anfordern", submitReset: "Passwort speichern",
    hintPassword: "Passwort: mindestens 8 Zeichen.",
    errFillFields: "Bitte E-Mail und Passwort eingeben.",
    errPasswordMismatch: "Die beiden Passwörter stimmen nicht überein.",
    okRegistered: (email) => `Konto eröffnet – willkommen, ${email}!`,
    okLoggedIn: (email) => `Angemeldet als ${email}.`,
    okLoggedOut: "Abgemeldet.",
    resetSentInfo: "Falls ein Konto zu dieser Adresse existiert, wurde eine E-Mail verschickt.",
    okResetDone: "Neues Passwort gesetzt – du bist angemeldet.",
    errorCodes: {
      auth_invalid_email: "Bitte eine gültige E-Mail-Adresse angeben.",
      auth_password_too_short: "Passwort: mindestens 8 Zeichen.",
      auth_password_too_long: "Passwort: höchstens 200 Zeichen.",
      auth_email_taken: "Für diese Adresse existiert bereits ein Konto.",
      auth_invalid_credentials: "E-Mail-Adresse oder Passwort ist falsch.",
      auth_rate_limited: "Zu viele Versuche – bitte später erneut probieren.",
      auth_reset_invalid: "Der Link ist ungültig oder abgelaufen.",
    },
  },
  fr: {
    guest: "Invité", stateOut: "Déconnecté", stateIn: "Connecté", memberSince: "Membre depuis",
    login: "Connexion", logout: "Déconnexion", register: "Créer un compte",
    loginTitle: "Connexion", registerTitle: "Créer un compte", forgotTitle: "Mot de passe oublié", resetTitle: "Nouveau mot de passe",
    loginTab: "Connexion", registerTab: "Créer un compte",
    emailLabel: "E-mail", passwordLabel: "Mot de passe", password2Label: "Répéter le mot de passe",
    forgotLink: "Mot de passe oublié ?", backToLogin: "Retour à la connexion",
    cancel: "Annuler", submitLogin: "Connexion", submitRegister: "Créer un compte",
    submitForgot: "Demander le lien", submitReset: "Enregistrer",
    hintPassword: "Mot de passe : au moins 8 caractères.",
    errFillFields: "Veuillez saisir l'e-mail et le mot de passe.",
    errPasswordMismatch: "Les deux mots de passe ne correspondent pas.",
    okRegistered: (email) => `Compte créé – bienvenue, ${email} !`,
    okLoggedIn: (email) => `Connecté en tant que ${email}.`,
    okLoggedOut: "Déconnecté.",
    resetSentInfo: "Si un compte existe pour cette adresse, un e-mail a été envoyé.",
    okResetDone: "Nouveau mot de passe enregistré – vous êtes connecté.",
    errorCodes: {
      auth_invalid_email: "Veuillez indiquer une adresse e-mail valide.",
      auth_password_too_short: "Mot de passe : au moins 8 caractères.",
      auth_password_too_long: "Mot de passe : au maximum 200 caractères.",
      auth_email_taken: "Un compte existe déjà pour cette adresse.",
      auth_invalid_credentials: "Adresse e-mail ou mot de passe incorrect.",
      auth_rate_limited: "Trop de tentatives – veuillez réessayer plus tard.",
      auth_reset_invalid: "Le lien est invalide ou a expiré.",
    },
  },
  it: {
    guest: "Ospite", stateOut: "Disconnesso", stateIn: "Connesso", memberSince: "Membro dal",
    login: "Accedi", logout: "Disconnetti", register: "Crea un conto",
    loginTitle: "Accedi", registerTitle: "Crea un conto", forgotTitle: "Password dimenticata", resetTitle: "Nuova password",
    loginTab: "Accedi", registerTab: "Crea un conto",
    emailLabel: "E-mail", passwordLabel: "Password", password2Label: "Ripeti la password",
    forgotLink: "Password dimenticata?", backToLogin: "Torna all'accesso",
    cancel: "Annulla", submitLogin: "Accedi", submitRegister: "Crea un conto",
    submitForgot: "Richiedi il link", submitReset: "Salva password",
    hintPassword: "Password: almeno 8 caratteri.",
    errFillFields: "Inserisci e-mail e password.",
    errPasswordMismatch: "Le due password non coincidono.",
    okRegistered: (email) => `Conto creato – benvenuto, ${email}!`,
    okLoggedIn: (email) => `Connesso come ${email}.`,
    okLoggedOut: "Disconnesso.",
    resetSentInfo: "Se esiste un conto con questo indirizzo, è stata inviata un'e-mail.",
    okResetDone: "Nuova password impostata – sei connesso.",
    errorCodes: {
      auth_invalid_email: "Inserisci un indirizzo e-mail valido.",
      auth_password_too_short: "Password: almeno 8 caratteri.",
      auth_password_too_long: "Password: massimo 200 caratteri.",
      auth_email_taken: "Esiste già un conto per questo indirizzo.",
      auth_invalid_credentials: "Indirizzo e-mail o password errati.",
      auth_rate_limited: "Troppi tentativi – riprova più tardi.",
      auth_reset_invalid: "Il link non è valido o è scaduto.",
    },
  },
  en: {
    guest: "Guest", stateOut: "Signed out", stateIn: "Signed in", memberSince: "Member since",
    login: "Log in", logout: "Log out", register: "Create account",
    loginTitle: "Log in", registerTitle: "Create account", forgotTitle: "Forgot password", resetTitle: "Set new password",
    loginTab: "Log in", registerTab: "Create account",
    emailLabel: "Email", passwordLabel: "Password", password2Label: "Repeat password",
    forgotLink: "Forgot password?", backToLogin: "Back to log in",
    cancel: "Cancel", submitLogin: "Log in", submitRegister: "Create account",
    submitForgot: "Request link", submitReset: "Save password",
    hintPassword: "Password: at least 8 characters.",
    errFillFields: "Please enter email and password.",
    errPasswordMismatch: "The two passwords do not match.",
    okRegistered: (email) => `Account created – welcome, ${email}!`,
    okLoggedIn: (email) => `Signed in as ${email}.`,
    okLoggedOut: "Signed out.",
    resetSentInfo: "If an account exists for this address, an email has been sent.",
    okResetDone: "New password set – you're signed in.",
    errorCodes: {
      auth_invalid_email: "Please enter a valid email address.",
      auth_password_too_short: "Password: at least 8 characters.",
      auth_password_too_long: "Password: at most 200 characters.",
      auth_email_taken: "An account already exists for this address.",
      auth_invalid_credentials: "Email address or password is incorrect.",
      auth_rate_limited: "Too many attempts – please try again later.",
      auth_reset_invalid: "The link is invalid or has expired.",
    },
  },
};

const langSwitch = document.getElementById("langSwitch");
let currentLang = "de";

function t(key, ...args){
  const dict = I18N[currentLang] || I18N.de;
  const entry = key in dict ? dict[key] : I18N.de[key];
  return typeof entry === "function" ? entry(...args) : entry;
}

/** Uebersetzt einen Fehler vom Server: bekannter "code" -> Woerterbuch, sonst die (deutsche) message. */
function authErrorText(err){
  const dict = I18N[currentLang] || I18N.de;
  return (err.code && dict.errorCodes[err.code]) || err.message;
}

function applyI18n(){
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

function setLanguage(lang){
  currentLang = I18N[lang] ? lang : "de";
  window.localStorage.setItem("kochbuchV2_lang", currentLang);
  document.documentElement.setAttribute("lang", currentLang);
  langSwitch.querySelectorAll(".lang-btn").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.lang === currentLang));
  });
  applyI18n();
  renderUserWidget();          // Zustandstext haengt von der Sprache ab
  if(!authDialog.hidden) setAuthMode(Auth.mode);   // Titel/Beschriftungen im offenen Dialog nachziehen
}

langSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest(".lang-btn");
  if(btn) setLanguage(btn.dataset.lang);
});

/**
 * Bewusst NICHT sofort aufgerufen: setLanguage() rendert schon das
 * Benutzer-Widget mit, dessen Elemente (authDialog, Auth, ...) erst weiter
 * unten im Skript als const deklariert werden. Aufruf folgt in init(),
 * nachdem der ganze Datei-Kopf durchlaufen ist.
 */
function initLanguage(){
  const saved = window.localStorage.getItem("kochbuchV2_lang");
  const browser = (navigator.language || "de").slice(0, 2).toLowerCase();
  setLanguage(saved || (I18N[browser] ? browser : "de"));
}

/* =========================================================================
   Benutzerverwaltung — Konto per E-Mail eroeffnen, anmelden, abmelden,
   Passwort vergessen. Oben rechts stehen der Benutzer und sein Zustand.
   Die Anmeldung haengt an einem HttpOnly-Cookie; das Passwort bleibt nie
   im Browser gespeichert, hier liegt nur, wer gerade angemeldet ist.
   ========================================================================= */
const userWidget = document.getElementById("userWidget");
const authDialog = document.getElementById("authDialog");
const authForm = document.getElementById("authForm");
const authTitle = document.getElementById("authTitle");
const authTabs = document.getElementById("authTabs");
const authTabLogin = document.getElementById("authTabLogin");
const authTabRegister = document.getElementById("authTabRegister");
const authEmail = document.getElementById("authEmail");
const authPasswordField = document.getElementById("authPasswordField");
const authPassword = document.getElementById("authPassword");
const authPassword2 = document.getElementById("authPassword2");
const authPassword2Field = document.getElementById("authPassword2Field");
const authForgotLink = document.getElementById("authForgotLink");
const authBackLink = document.getElementById("authBackLink");
const authHint = document.getElementById("authHint");
const authInfo = document.getElementById("authInfo");
const authError = document.getElementById("authError");
const authSubmitBtn = document.getElementById("authSubmitBtn");

// mode: "login" | "register" | "forgot" | "reset"
const Auth = { user: null, mode: "login", resetToken: null };

function renderUserWidget(){
  if(Auth.user){
    const since = new Date(Auth.user.createdAt).toLocaleDateString(currentLang);
    userWidget.innerHTML = `
      <span class="user-avatar" aria-hidden="true">${escapeHtml(Auth.user.email.charAt(0))}</span>
      <span class="user-info" title="${escapeHtml(Auth.user.email)}">
        <span class="user-name">${escapeHtml(Auth.user.email)}</span>
        <span class="user-state user-state-in"><span class="user-dot"></span>${t("stateIn")}<span class="user-since"> · ${t("memberSince")} ${since}</span></span>
      </span>
      <button type="button" class="btn btn-ghost btn-small" data-action="logout">${t("logout")}</button>`;
  }else{
    userWidget.innerHTML = `
      <span class="user-avatar user-avatar-guest" aria-hidden="true">?</span>
      <span class="user-info">
        <span class="user-name">${t("guest")}</span>
        <span class="user-state"><span class="user-dot"></span>${t("stateOut")}</span>
      </span>
      <button type="button" class="btn btn-ghost btn-small" data-action="login">${t("login")}</button>
      <button type="button" class="btn btn-primary btn-small" data-action="register">${t("register")}</button>`;
  }
}

async function loadSession(){
  try{
    const session = await API.get("/session");
    Auth.user = session.authenticated ? session.user : null;
  }catch{
    Auth.user = null;   // Server nicht erreichbar: als Gast anzeigen, die Hauptmeldung kommt aus init()
  }
  renderUserWidget();
}

function showAuthError(message){
  authInfo.hidden = true;
  authError.textContent = message;
  authError.hidden = false;
}

function showAuthInfo(message){
  authError.hidden = true;
  authInfo.textContent = message;
  authInfo.hidden = false;
}

/** Blendet Felder/Beschriftungen je nach Zustand ein bzw. aus - vier Zustaende, ein Formular. */
function setAuthMode(mode){
  Auth.mode = mode;
  const register = mode === "register";
  const forgot = mode === "forgot";
  const reset = mode === "reset";

  authTitle.textContent = t(register ? "registerTitle" : forgot ? "forgotTitle" : reset ? "resetTitle" : "loginTitle");
  authSubmitBtn.textContent = t(register ? "submitRegister" : forgot ? "submitForgot" : reset ? "submitReset" : "submitLogin");

  authTabs.hidden = forgot || reset;
  authTabLogin.setAttribute("aria-selected", String(mode === "login"));
  authTabRegister.setAttribute("aria-selected", String(register));

  authEmail.closest(".field").hidden = reset;   // Reset laeuft ueber den Link-Token, keine Adresse noetig
  authPasswordField.hidden = forgot;
  authPassword2Field.hidden = !(register || reset);
  authHint.hidden = !(register || reset);

  authForgotLink.hidden = !(mode === "login");
  authBackLink.hidden = !(forgot || reset);

  authError.hidden = true;
  authInfo.hidden = true;
}

function openAuthDialog(mode){
  authForm.reset();
  setAuthMode(mode);
  authDialog.showModal();
  (mode === "reset" ? authPassword : authEmail).focus();
}

userWidget.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if(!btn) return;
  if(btn.dataset.action === "login") openAuthDialog("login");
  if(btn.dataset.action === "register") openAuthDialog("register");
  if(btn.dataset.action === "logout"){
    await guard(async () => {
      await API.del("/session");
      Auth.user = null;
      renderUserWidget();
    }, { success: t("okLoggedOut") });
  }
});

authTabLogin.addEventListener("click", () => setAuthMode("login"));
authTabRegister.addEventListener("click", () => setAuthMode("register"));
authForgotLink.addEventListener("click", () => setAuthMode("forgot"));
authBackLink.addEventListener("click", () => setAuthMode("login"));
document.getElementById("authCloseBtn").addEventListener("click", () => authDialog.close());
document.getElementById("authCancelBtn").addEventListener("click", () => authDialog.close());
// Passwoerter nicht im Formular stehen lassen. Nur wenn der Dialog wirklich zu
// ist: ein verspaetetes close-Ereignis darf ein schon wieder geoeffnetes
// Formular nicht leeren.
authDialog.addEventListener("close", () => { if(!authDialog.open) authForm.reset(); });

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = Auth.mode;
  const email = authEmail.value.trim();
  const password = authPassword.value;

  if(mode === "forgot"){
    if(!email){ showAuthError(t("errFillFields")); return; }
  }else if(mode === "reset"){
    if(!password){ showAuthError(t("errFillFields")); return; }
    if(password !== authPassword2.value){ showAuthError(t("errPasswordMismatch")); return; }
  }else{
    if(!email || !password){ showAuthError(t("errFillFields")); return; }
    if(mode === "register" && password !== authPassword2.value){ showAuthError(t("errPasswordMismatch")); return; }
  }

  authSubmitBtn.disabled = true;
  authError.hidden = true;
  try{
    if(mode === "login"){
      const data = await API.post("/session", { email, password });
      Auth.user = data.user;
      renderUserWidget();
      authDialog.close();
      showStatus(t("okLoggedIn", data.user.email), "success");
    }else if(mode === "register"){
      const data = await API.post("/users", { email, password });
      Auth.user = data.user;
      renderUserWidget();
      authDialog.close();
      showStatus(t("okRegistered", data.user.email), "success");
    }else if(mode === "forgot"){
      await API.post("/password-reset", { email });
      showAuthInfo(t("resetSentInfo"));
    }else if(mode === "reset"){
      const data = await API.post("/password-reset/confirm", { token: Auth.resetToken, password });
      Auth.user = data.user;
      Auth.resetToken = null;
      renderUserWidget();
      authDialog.close();
      showStatus(t("okResetDone"), "success");
    }
  }catch(err){
    showAuthError(authErrorText(err));
    if(mode !== "forgot"){
      authPassword.value = "";
      authPassword2.value = "";
      authPassword.focus();
    }
  }finally{
    authSubmitBtn.disabled = false;
  }
});

/** Kommt der Besucher ueber einen Passwort-Reset-Link (?reset=TOKEN), gleich den Dialog dafuer oeffnen. */
function checkResetLinkInUrl(){
  const params = new URLSearchParams(location.search);
  const token = params.get("reset");
  if(!token) return;
  Auth.resetToken = token;
  openAuthDialog("reset");
  // Token aus der Adresszeile entfernen - er soll nicht in Verlauf/Lesezeichen haengen bleiben.
  params.delete("reset");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
}

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

const DEFAULT_RECIPE_QUERY = { search: "", sortBy: "name", sortDir: "asc", page: 1, pageSize: 20 };
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

function renderRecipeTable(){
  const { items, total, page, totalPages } = DB.recipesPage;
  const hasSearch = recipeQuery.search.trim().length > 0;

  recipeTableBody.innerHTML = "";
  recipeEmptyState.hidden = items.length > 0;
  recipeEmptyState.textContent = hasSearch
    ? `Keine Rezepte gefunden für "${recipeQuery.search.trim()}".`
    : 'Noch keine Rezepte vorhanden. Leg mit "Rezept erstellen" los.';

  items.forEach(recipe => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="recipe-name-cell">${imageIndicator(recipe.imageCount)}${escapeHtml(recipe.name)}</td>
      <td>${truncate(recipe.shortDesc, 100)}</td>
      <td class="menu-cell">
        <button class="btn btn-icon" data-action="edit" data-id="${recipe.id}" title="Bearbeiten" aria-label="Bearbeiten">✏️</button>
        <button class="btn btn-icon" data-action="delete" data-id="${recipe.id}" title="Löschen" aria-label="Löschen">🗑️</button>
      </td>
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

function openRecipeDialog(recipe){
  refreshIngredientCatalogDatalist();
  fillCategorySelect();
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
  recipeNameInput.focus();
}

function closeRecipeDialog(){
  closeImageLightbox();
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
   Start
   ========================================================================= */
(async function init(){
  initLanguage();
  loadSession();   // parallel: der Benutzerbereich soll nicht auf die Rezeptdaten warten
  checkResetLinkInUrl();
  const loaded = await guard(() => DB.load());
  if(!loaded){
    // Ohne Serververbindung hat Weiterarbeiten keinen Sinn - die Oberflaeche
    // bleibt leer und die Fehlermeldung stehen.
    return;
  }
  await loadRecipes();
  clearStatus();
  renderFridgeList();
  await offerLegacyImport();
})();
