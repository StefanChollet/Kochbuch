"use strict";

/* =========================================================================
   Anmeldeseite. Nach dem Login geht es zurueck auf die Travelfy-Seite aus
   ?next= - aber nur auf eine eigene Seite (safeNext in common.js), nie auf
   eine fremde Adresse oder eine andere Anwendung.
   ========================================================================= */
const authForm = document.getElementById("authForm");
const authUsername = document.getElementById("authUsername");
const authPassword = document.getElementById("authPassword");
const authError = document.getElementById("authError");
const authSubmitBtn = document.getElementById("authSubmitBtn");

const nextPage = safeNext(new URLSearchParams(window.location.search).get("next"));

async function loadLoginUsers(){
  try{
    const { usernames } = await API.get("/auth/users");
    authUsername.innerHTML = `<option value="">– Benutzer wählen –</option>` +
      usernames.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  }catch(err){
    authError.textContent = err.message;
    authError.hidden = false;
  }
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authSubmitBtn.disabled = true;
  try{
    await API.post("/auth/login", {
      username: authUsername.value.trim(),
      password: authPassword.value
    });
    resetViewMode();   // jede neue Anmeldung startet mit der Ampel auf Rot
    window.location.replace(nextPage);
  }catch(err){
    authError.textContent = err.message;
    authError.hidden = false;
    authSubmitBtn.disabled = false;
  }
});

(async function init(){
  // Schon angemeldet? Dann gleich weiter.
  try{
    const status = await API.get("/auth/status");
    if(status.user){
      window.location.replace(nextPage);
      return;
    }
  }catch(err){
    showStatus(err.message, "error");
  }
  await loadLoginUsers();
  authUsername.focus();
})();
