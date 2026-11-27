"use strict";

/* =========================================================================
   Dia-Show der Detailseite.

   1. "Dia-Show erstellen" oeffnet die Einstellungen: alle Bilder der Reise
      (Fotos und uebernommene Zeichenblaetter) in der Reihenfolge der Reise,
      Anzeigedauer je Bild (Standard 10 s), Uebergang (Standard 2 s) und
      Art des Uebergangs (Ueberblenden, Schieben, Zoomen).
   2. "Starten" spielt die Bilder im Vollbild ab, jedes so gross wie moeglich,
      in einer Endlosschleife - beendet wird nur von Hand (Stopp oder Esc).
      Pause/Weiter, vor und zurueck jederzeit; danach beliebig oft neu starten.
   ========================================================================= */
const Diashow = (() => {
  const dialog = document.getElementById("slideDialog");
  const strip = document.getElementById("slideStrip");
  const info = document.getElementById("slideInfo");
  const durationInput = document.getElementById("slideDuration");
  const transitionInput = document.getElementById("slideTransition");
  const effectSelect = document.getElementById("slideEffect");
  const show = document.getElementById("slideShow");
  const layers = [document.getElementById("slideImgA"), document.getElementById("slideImgB")];
  const pauseBtn = document.getElementById("slidePauseBtn");
  const counter = document.getElementById("slideCounter");
  const pausedNote = document.getElementById("slidePaused");
  const SETTINGS_KEY = "travelfy_slideshow";

  let slides = [];        // [{ src, name }]
  let index = 0;          // aktuelles Bild
  let current = 0;        // welche der beiden Ebenen gerade sichtbar ist
  let running = false;    // Show offen
  let playing = false;    // laeuft (nicht pausiert)
  let busy = false;       // Uebergang laeuft
  let timer = null;
  let transitionTimer = null;
  let idleTimer = null;
  let wakeLock = null;
  let settings = { duration: 10, transition: 2, effect: "fade" };

  /* ------------------------------------------------- Einstellungen */

  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function readSettings(){
    return {
      duration: clamp(durationInput.value, 1, 600, 10),
      transition: clamp(transitionInput.value, 0, 10, 2),
      effect: ["fade", "slide", "zoom"].includes(effectSelect.value) ? effectSelect.value : "fade",
    };
  }

  function formatTime(seconds){
    const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
    return m ? `${m} min ${s} s` : `${s} s`;
  }

  function updateInfo(){
    const s = readSettings();
    const round = slides.length * (s.duration + s.transition);
    info.textContent = `${slides.length} ${slides.length === 1 ? "Bild" : "Bilder"} in der Reihenfolge der Reise – eine Runde dauert ${formatTime(round)}, danach beginnt sie von vorn.`;
  }
  [durationInput, transitionInput, effectSelect].forEach(el => el.addEventListener("input", updateInfo));

  /** Einstellungen oeffnen. list: [{ src, name }] in der gewuenschten Reihenfolge. */
  function open(list){
    slides = list.filter(s => s && s.src);
    if(!slides.length){
      showStatus("Diese Reise hat noch keine Bilder – zuerst Fotos hochladen oder mit „Zeichnen“ ein Zeichenblatt erstellen.", "error");
      return;
    }
    try{
      const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
      if(saved){
        durationInput.value = String(clamp(saved.duration, 1, 600, 10));
        transitionInput.value = String(clamp(saved.transition, 0, 10, 2));
        if(["fade", "slide", "zoom"].includes(saved.effect)) effectSelect.value = saved.effect;
      }
    }catch{ /* Standardwerte */ }
    strip.innerHTML = slides.map((s, i) =>
      `<li><span class="slide-strip-nr">${i + 1}</span><img src="${escapeHtml(s.src)}" alt="${escapeHtml(s.name || `Bild ${i + 1}`)}" loading="lazy"></li>`).join("");
    updateInfo();
    dialog.showModal();
  }

  document.getElementById("slideStartBtn").addEventListener("click", () => {
    settings = readSettings();
    durationInput.value = String(settings.duration);
    transitionInput.value = String(settings.transition);
    try{ window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch{ /* egal */ }
    dialog.close();
    start();
  });

  /* ------------------------------------------------------- Ebenen */

  /** Startlage eines hereinkommenden Bildes bzw. Endlage des hinausgehenden. */
  const ENTER = { fade: { opacity: "0", transform: "none" }, slide: { opacity: "1", transform: "translateX(100%)" }, zoom: { opacity: "0", transform: "scale(1.25)" } };
  const LEAVE = { fade: { opacity: "0", transform: "none" }, slide: { opacity: "1", transform: "translateX(-100%)" }, zoom: { opacity: "0", transform: "scale(0.85)" } };
  const SHOWN = { opacity: "1", transform: "none" };

  function setLayer(img, state, seconds){
    img.style.transition = seconds > 0 ? `opacity ${seconds}s ease-in-out, transform ${seconds}s ease-in-out` : "none";
    img.style.opacity = state.opacity;
    img.style.transform = state.transform;
  }

  /** Bild in eine Ebene laden und warten, bis es angezeigt werden kann. */
  async function load(img, slide){
    img.src = slide.src;
    img.alt = slide.name || "";
    // Hoechstens 4 s warten - ein haengendes oder defektes Bild haelt die Show nicht an
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    try{ await Promise.race([img.decode(), wait(4000)]); }catch{ /* defekt: wird leer gezeigt */ }
  }

  function updateCounter(){
    counter.textContent = `${index + 1} / ${slides.length}`;
  }

  /* ------------------------------------------------------ Ablauf */

  function schedule(){
    clearTimeout(timer);
    if(running && playing) timer = setTimeout(() => goTo(index + 1, true), settings.duration * 1000);
  }

  /** Zum Bild n wechseln (mit Uebergang oder sofort). */
  async function goTo(n, animate){
    if(!running) return;
    clearTimeout(timer);
    if(busy) finishTransition();
    const next = (n % slides.length + slides.length) % slides.length;
    if(slides.length === 1 && next === index && animate){ schedule(); return; }
    busy = true;
    const incoming = layers[1 - current], outgoing = layers[current];
    await load(incoming, slides[next]);
    if(!running){ busy = false; return; }
    const seconds = animate ? settings.transition : 0;
    // Startlage ohne Animation setzen, dann zur sichtbaren Lage gleiten
    setLayer(incoming, ENTER[settings.effect], 0);
    incoming.style.zIndex = "2";
    outgoing.style.zIndex = "1";
    void incoming.offsetWidth;   // Startlage wirksam machen, bevor der Uebergang beginnt
    setLayer(incoming, SHOWN, seconds);
    setLayer(outgoing, LEAVE[settings.effect], seconds);
    index = next;
    current = 1 - current;
    updateCounter();
    transitionTimer = setTimeout(() => { busy = false; schedule(); }, seconds * 1000);
  }

  /** Laufenden Uebergang sofort abschliessen (bei Tastendruck mittendrin). */
  function finishTransition(){
    clearTimeout(transitionTimer);
    setLayer(layers[current], SHOWN, 0);
    setLayer(layers[1 - current], { opacity: "0", transform: "none" }, 0);
    busy = false;
  }

  function setPlaying(on){
    playing = on;
    pauseBtn.textContent = on ? "⏸" : "▶";
    pauseBtn.title = on ? "Pause (Leertaste)" : "Weiter (Leertaste)";
    pauseBtn.setAttribute("aria-label", on ? "Pause" : "Weiter");
    pausedNote.hidden = on;
    if(on) schedule(); else clearTimeout(timer);
  }

  async function start(){
    running = true;
    index = 0;
    current = 0;
    show.hidden = false;
    updateCounter();
    layers.forEach(img => { setLayer(img, { opacity: "0", transform: "none" }, 0); img.removeAttribute("src"); });
    // Vollbild (braucht den Klick auf "Starten" als Ausloeser) und Bildschirm
    // anlassen - beides anfordern, aber nicht darauf warten: manche Browser
    // antworten nie, die Show muss trotzdem laufen.
    try{
      if(show.requestFullscreen && !document.fullscreenElement) show.requestFullscreen().catch(() => { /* dann eben im Fenster */ });
    }catch{ /* dann eben im Fenster */ }
    requestWakeLock();
    await load(layers[0], slides[0]);
    if(!running) return;
    setLayer(layers[0], SHOWN, 0);
    layers[0].style.zIndex = "2";
    updateCounter();
    setPlaying(true);
    wakeControls();
  }

  /** Dia-Show beenden - nur von Hand (Stopp-Knopf, Esc). */
  function stop(){
    if(!running) return;
    running = false;
    playing = false;
    busy = false;
    clearTimeout(timer);
    clearTimeout(transitionTimer);
    clearTimeout(idleTimer);
    show.hidden = true;
    show.classList.remove("is-idle");
    layers.forEach(img => img.removeAttribute("src"));
    if(document.fullscreenElement === show && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if(wakeLock){ wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  /* ------------------------------------------------------ Steuerung */

  pauseBtn.addEventListener("click", () => setPlaying(!playing));
  document.getElementById("slideNextBtn").addEventListener("click", () => goTo(index + 1, true));
  document.getElementById("slidePrevBtn").addEventListener("click", () => goTo(index - 1, true));
  document.getElementById("slideStopBtn").addEventListener("click", stop);

  document.addEventListener("keydown", (e) => {
    if(!running) return;
    if(e.key === " " || e.key === "Spacebar"){ e.preventDefault(); setPlaying(!playing); wakeControls(); }
    else if(e.key === "ArrowRight"){ e.preventDefault(); goTo(index + 1, true); wakeControls(); }
    else if(e.key === "ArrowLeft"){ e.preventDefault(); goTo(index - 1, true); wakeControls(); }
    else if(e.key === "Escape"){ e.preventDefault(); stop(); }
  });

  // Esc im Vollbild beendet zuerst das Vollbild - das gilt als Stopp von Hand.
  document.addEventListener("fullscreenchange", () => {
    if(running && !document.fullscreenElement) stop();
  });

  // Bedienleiste und Mauszeiger blenden sich nach kurzer Ruhe aus
  function wakeControls(){
    show.classList.remove("is-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if(running) show.classList.add("is-idle"); }, 4000);
  }
  show.addEventListener("pointermove", wakeControls);
  show.addEventListener("pointerdown", wakeControls);

  /** Bildschirm waehrend der Show anlassen (gibt der Browser beim Tab-Wechsel selbst frei). */
  async function requestWakeLock(){
    if(!navigator.wakeLock || wakeLock) return;
    try{
      const lock = await navigator.wakeLock.request("screen");
      if(!running){ lock.release().catch(() => {}); return; }
      wakeLock = lock;
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }catch{ /* Bildschirm darf ausgehen */ }
  }
  document.addEventListener("visibilitychange", () => {
    if(running && document.visibilityState === "visible") requestWakeLock();
  });

  return { open, stop };
})();
