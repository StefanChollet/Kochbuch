"use strict";

/* =========================================================================
   Zeichenblatt der Detailseite.

   Ein grosses Fenster mit einer Zeichenflaeche (1600 x 1000 Punkte):
   Freihand, Linie, Text, Kreis, Quadrat, Dreieck. Jede Zeichnung besteht
   aus einzelnen Elementen - sie lassen sich auswaehlen, verschieben und
   loeschen. In eine gewaehlte Form (Kreis, Quadrat, Dreieck) laesst sich
   ein Foto einsetzen ("Foto einfuegen" oder Strg+V): es wird auf die Form
   zugeschnitten. Ohne gewaehlte Form wird das Foto ein eigenes Element.

   "In Bilder uebernehmen" macht aus dem Blatt ein PNG und gibt es an die
   Detailseite weiter (openDrawing(onDone)); gespeichert wird es dort
   zusammen mit der Reise.
   ========================================================================= */
const Zeichnen = (() => {
  const dialog = document.getElementById("drawDialog");
  const canvas = document.getElementById("drawCanvas");
  const stage = document.getElementById("drawStage");
  const ctx = canvas.getContext("2d");
  const hint = document.getElementById("drawHint");
  const colorInput = document.getElementById("drawColor");
  const widthSelect = document.getElementById("drawWidth");
  const photoInput = document.getElementById("drawPhotoInput");
  const W = canvas.width;
  const H = canvas.height;

  const HINTS = {
    select: "Element anklicken zum Auswählen, ziehen zum Verschieben. Entf löscht es.",
    free: "Mit gedrückter Maustaste frei zeichnen.",
    line: "Vom Anfangs- zum Endpunkt ziehen.",
    text: "Ins Blatt klicken, Text tippen, Enter übernimmt.",
    ellipse: "Ziehen für einen Kreis – mit Umschalt genau rund. Danach kann ein Foto hinein.",
    rect: "Ziehen für ein Quadrat – mit Umschalt genau quadratisch. Danach kann ein Foto hinein.",
    triangle: "Ziehen für ein Dreieck. Danach kann ein Foto hinein.",
  };
  const FILLABLE = new Set(["rect", "ellipse", "triangle", "image"]);

  let elements = [];      // die Zeichnung
  let history = [];       // fruehere Staende fuer "Rueckgaengig"
  let tool = "rect";
  let selected = null;    // gewaehltes Element
  let action = null;      // laufende Mausaktion
  let textInput = null;   // offenes Textfeld
  let onDone = null;
  let changed = false;

  /* ---------------------------------------------------------- Hilfen */

  const strokeWidth = () => Number(widthSelect.value) || 4;
  const textSize = () => 16 + strokeWidth() * 4;

  function toCanvas(e){
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }

  /** Box mit positiver Breite/Hoehe; mit Umschalt quadratisch. */
  function box(a, b, square){
    let w = b.x - a.x, h = b.y - a.y;
    if(square){
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
  }

  function snapshot(){
    history.push(elements.map(el => ({ ...el, points: el.points ? el.points.map(p => [...p]) : undefined })));
    if(history.length > 100) history.shift();
    changed = true;
  }

  function loadImage(dataUrl){
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Das Bild konnte nicht gelesen werden."));
      img.src = dataUrl;
    });
  }

  function readFile(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`"${file.name}" konnte nicht gelesen werden.`));
      reader.readAsDataURL(file);
    });
  }

  /* ----------------------------------------------------------- Formen */

  /** Umriss einer Form als Pfad (fuer Zeichnen, Zuschneiden, Treffer). */
  function shapePath(c, el){
    c.beginPath();
    if(el.type === "rect" || el.type === "image"){
      c.rect(el.x, el.y, el.w, el.h);
    }else if(el.type === "ellipse"){
      c.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(el.w / 2, 0.5), Math.max(el.h / 2, 0.5), 0, 0, Math.PI * 2);
    }else if(el.type === "triangle"){
      c.moveTo(el.x + el.w / 2, el.y);
      c.lineTo(el.x + el.w, el.y + el.h);
      c.lineTo(el.x, el.y + el.h);
      c.closePath();
    }
  }

  /** Foto so in die Box legen, dass es sie ganz fuellt (wie object-fit: cover). */
  function drawCover(c, img, el){
    const scale = Math.max(el.w / img.naturalWidth, el.h / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    c.drawImage(img, el.x + (el.w - w) / 2, el.y + (el.h - h) / 2, w, h);
  }

  function drawElement(c, el){
    c.save();
    c.strokeStyle = el.color;
    c.fillStyle = el.color;
    c.lineWidth = el.width;
    c.lineCap = "round";
    c.lineJoin = "round";
    if(el.type === "free"){
      c.beginPath();
      el.points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
      if(el.points.length === 1) c.lineTo(el.points[0][0] + 0.1, el.points[0][1]);
      c.stroke();
    }else if(el.type === "line"){
      c.beginPath();
      c.moveTo(el.x1, el.y1);
      c.lineTo(el.x2, el.y2);
      c.stroke();
    }else if(el.type === "text"){
      c.font = `600 ${el.size}px "IBM Plex Sans", system-ui, sans-serif`;
      c.textBaseline = "top";
      el.text.split("\n").forEach((line, i) => c.fillText(line, el.x, el.y + i * el.size * 1.25));
    }else{
      if(el.img){
        c.save();
        shapePath(c, el);
        c.clip();
        drawCover(c, el.img, el);
        c.restore();
      }
      if(el.type !== "image" || !el.img){
        shapePath(c, el);
        c.stroke();
      }
    }
    c.restore();
  }

  /** Umgebendes Rechteck eines Elements (fuer Auswahl und Verschieben). */
  function bounds(el){
    if(el.type === "line"){
      return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
    }
    if(el.type === "free"){
      const xs = el.points.map(p => p[0]), ys = el.points.map(p => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if(el.type === "text"){
      ctx.font = `600 ${el.size}px "IBM Plex Sans", system-ui, sans-serif`;
      const lines = el.text.split("\n");
      return { x: el.x, y: el.y, w: Math.max(...lines.map(l => ctx.measureText(l).width)), h: lines.length * el.size * 1.25 };
    }
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }

  function distToSegment(p, a, b){
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Oberstes Element unter dem Punkt (Formen: innen oder auf dem Rand). */
  function hitTest(p){
    for(let i = elements.length - 1; i >= 0; i--){
      const el = elements[i];
      const tol = el.width / 2 + 8;
      if(el.type === "line"){
        if(distToSegment(p, { x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }) <= tol) return el;
      }else if(el.type === "free"){
        for(let k = 1; k < el.points.length; k++){
          const a = { x: el.points[k - 1][0], y: el.points[k - 1][1] }, b = { x: el.points[k][0], y: el.points[k][1] };
          if(distToSegment(p, a, b) <= tol) return el;
        }
        if(el.points.length === 1 && Math.hypot(p.x - el.points[0][0], p.y - el.points[0][1]) <= tol) return el;
      }else if(el.type === "text"){
        const b = bounds(el);
        if(p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6) return el;
      }else{
        shapePath(ctx, el);
        ctx.lineWidth = el.width + 16;
        if(ctx.isPointInPath(p.x, p.y) || ctx.isPointInStroke(p.x, p.y)) return el;
      }
    }
    return null;
  }

  function moveElement(el, dx, dy){
    if(el.type === "line"){ el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy; }
    else if(el.type === "free"){ el.points.forEach(p => { p[0] += dx; p[1] += dy; }); }
    else { el.x += dx; el.y += dy; }
  }

  /* ---------------------------------------------------------- Zeichnen */

  function render(){
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    elements.forEach(el => drawElement(ctx, el));
    if(action && action.preview) drawElement(ctx, action.preview);
    if(selected && elements.includes(selected)){
      const b = bounds(selected);
      ctx.save();
      ctx.setLineDash([10, 6]);
      ctx.strokeStyle = "#1e88e5";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16);
      ctx.restore();
    }
    updateButtons();
  }

  function updateButtons(){
    document.getElementById("drawUndoBtn").disabled = history.length === 0;
    document.getElementById("drawDeleteBtn").disabled = !selected;
    document.getElementById("drawClearBtn").disabled = elements.length === 0;
    const photoBtn = document.getElementById("drawPhotoBtn");
    photoBtn.textContent = selected && FILLABLE.has(selected.type) ? "🖼 Foto in Form einsetzen" : "🖼 Foto einfügen";
  }

  function setTool(name){
    commitText();
    tool = name;
    dialog.querySelectorAll(".draw-tool").forEach(b => {
      const on = b.dataset.tool === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    });
    canvas.dataset.tool = name;
    hint.textContent = HINTS[name];
    if(name !== "select"){ selected = null; render(); }
  }

  /* ----------------------------------------------------------- Maus */

  canvas.addEventListener("pointerdown", (e) => {
    if(e.button !== 0) return;
    const p = toCanvas(e);
    if(textInput){ commitText(); return; }

    if(tool === "text"){
      // Sonst holt sich die Zeichenflaeche nach dem Klick den Fokus zurueck,
      // und das neue Textfeld schliesst sich sofort wieder.
      e.preventDefault();
      openTextInput(p);
      return;
    }

    if(tool === "select"){
      selected = hitTest(p);
      if(selected){
        snapshot();
        action = { kind: "move", last: p, moved: false };
        canvas.setPointerCapture(e.pointerId);
      }
      render();
      return;
    }

    const base = { color: colorInput.value, width: strokeWidth() };
    action = { kind: "draw", start: p, preview: null, base };
    if(tool === "free") action.preview = { ...base, type: "free", points: [[p.x, p.y]] };
    canvas.setPointerCapture(e.pointerId);
    render();
  });

  canvas.addEventListener("pointermove", (e) => {
    if(!action) return;
    const p = toCanvas(e);
    if(action.kind === "move"){
      moveElement(selected, p.x - action.last.x, p.y - action.last.y);
      action.last = p;
      action.moved = true;
    }else if(tool === "free"){
      action.preview.points.push([p.x, p.y]);
    }else if(tool === "line"){
      action.preview = { ...action.base, type: "line", x1: action.start.x, y1: action.start.y, x2: p.x, y2: p.y };
    }else{
      action.preview = { ...action.base, type: tool, ...box(action.start, p, e.shiftKey) };
    }
    render();
  });

  function endAction(){
    if(!action) return;
    if(action.kind === "move"){
      if(!action.moved) history.pop();   // nur angeklickt: kein Rueckgaengig-Schritt
    }else if(action.preview){
      const el = action.preview;
      const tooSmall = (el.type === "line" && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 4)
        || (FILLABLE.has(el.type) && (el.w < 6 || el.h < 6));
      if(!tooSmall){
        snapshot();
        elements.push(el);
        // Neue Form gleich auswaehlen - so kann direkt ein Foto hinein.
        if(FILLABLE.has(el.type)) selected = el;
      }
    }
    action = null;
    render();
  }

  // Beim Text-Werkzeug darf der Mausklick den Fokus nicht vom neuen
  // Textfeld wegnehmen (das passiert beim mousedown, nicht beim pointerdown).
  canvas.addEventListener("mousedown", (e) => {
    if(tool === "text" || textInput) e.preventDefault();
  });

  canvas.addEventListener("pointerup", endAction);
  canvas.addEventListener("pointercancel", endAction);

  /* ------------------------------------------------------------ Text */

  function openTextInput(p){
    const r = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const scale = r.width / W;
    textInput = document.createElement("textarea");
    textInput.className = "draw-text-input";
    textInput.rows = 1;
    textInput.placeholder = "Text …";
    textInput.style.left = `${r.left - s.left + stage.scrollLeft + p.x * scale}px`;
    textInput.style.top = `${r.top - s.top + stage.scrollTop + p.y * scale}px`;
    textInput.style.fontSize = `${textSize() * scale}px`;
    textInput.style.color = colorInput.value;
    textInput.dataset.x = p.x;
    textInput.dataset.y = p.y;
    stage.appendChild(textInput);
    textInput.addEventListener("keydown", (e) => {
      if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); commitText(); }
      if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); cancelText(); }
    });
    const input = textInput;
    // Wachsen beim Tippen, damit der ganze Text sichtbar bleibt
    input.addEventListener("input", () => {
      input.style.width = `${Math.max(12, input.value.split("\n").reduce((m, l) => Math.max(m, l.length), 0) + 2)}ch`;
      input.rows = Math.max(1, input.value.split("\n").length);
    });
    setTimeout(() => {
      if(textInput !== input) return;
      input.focus();
      // Erst nach dem Fokussieren: Klick daneben uebernimmt den Text.
      input.addEventListener("blur", () => setTimeout(() => { if(textInput === input) commitText(); }, 0));
    }, 0);
  }

  function commitText(){
    if(!textInput) return;
    const input = textInput;
    textInput = null;
    const text = input.value.replace(/\s+$/, "");
    if(text){
      snapshot();
      elements.push({ type: "text", x: Number(input.dataset.x), y: Number(input.dataset.y), text,
        color: colorInput.value, width: strokeWidth(), size: textSize() });
    }
    input.remove();
    render();
  }

  function cancelText(){
    if(!textInput) return;
    textInput.remove();
    textInput = null;
  }

  /* ----------------------------------------------------------- Fotos */

  /** Foto in die gewaehlte Form setzen - oder als eigenes Element auf das Blatt. */
  async function insertPhoto(dataUrl){
    let img;
    try{ img = await loadImage(dataUrl); }
    catch(err){ showStatus(err.message, "error"); return; }
    snapshot();
    if(selected && FILLABLE.has(selected.type)){
      selected.img = img;
    }else{
      const scale = Math.min((W * 0.45) / img.naturalWidth, (H * 0.45) / img.naturalHeight, 1);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      const el = { type: "image", x: (W - w) / 2, y: (H - h) / 2, w, h, img, color: colorInput.value, width: strokeWidth() };
      elements.push(el);
      selected = el;
      setTool("select");
      selected = el;
    }
    render();
  }

  document.getElementById("drawPhotoBtn").addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = "";
    if(!file) return;
    try{ await insertPhoto(await readFile(file)); }
    catch(err){ showStatus(err.message, "error"); }
  });

  // Strg+V: Foto aus der Zwischenablage (z.B. Bildschirmfoto oder "Bild kopieren")
  document.addEventListener("paste", async (e) => {
    if(!dialog.open || textInput) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith("image/"));
    if(!item) return;
    e.preventDefault();
    try{ await insertPhoto(await readFile(item.getAsFile())); }
    catch(err){ showStatus(err.message, "error"); }
  });

  /* ---------------------------------------------------------- Knoepfe */

  dialog.querySelectorAll(".draw-tool").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));

  function undo(){
    commitText();
    if(!history.length) return;
    elements = history.pop();
    selected = null;
    render();
  }

  function deleteSelected(){
    if(!selected) return;
    snapshot();
    elements = elements.filter(el => el !== selected);
    selected = null;
    render();
  }

  document.getElementById("drawUndoBtn").addEventListener("click", undo);
  document.getElementById("drawDeleteBtn").addEventListener("click", deleteSelected);
  document.getElementById("drawClearBtn").addEventListener("click", () => {
    if(!elements.length || !window.confirm("Das ganze Blatt leeren?")) return;
    snapshot();
    elements = [];
    selected = null;
    render();
  });

  const SHORTCUTS = { v: "select", f: "free", l: "line", t: "text", k: "ellipse", q: "rect", d: "triangle" };
  dialog.addEventListener("keydown", (e) => {
    if(textInput || e.target.matches("input, select, textarea")) return;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); undo(); return; }
    if(e.key === "Delete" || e.key === "Backspace"){ e.preventDefault(); deleteSelected(); return; }
    if(!e.ctrlKey && !e.metaKey && !e.altKey && SHORTCUTS[e.key.toLowerCase()]) setTool(SHORTCUTS[e.key.toLowerCase()]);
  });

  /* ------------------------------------------------ Oeffnen / Schliessen */

  function confirmDiscard(){
    return !changed || !elements.length || window.confirm("Zeichnung verwerfen?");
  }

  function close(){
    cancelText();
    dialog.close();
  }

  document.getElementById("drawCloseBtn").addEventListener("click", () => { if(confirmDiscard()) close(); });
  document.getElementById("drawCancelBtn").addEventListener("click", () => { if(confirmDiscard()) close(); });
  dialog.addEventListener("cancel", (e) => {        // Esc
    if(textInput){ e.preventDefault(); cancelText(); return; }
    if(!confirmDiscard()) e.preventDefault();
    else cancelText();
  });

  /** Blatt als Bild: PNG, bei sehr grossen Fotos JPEG (Grenze 8 MB je Bild). */
  function exportImage(){
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const c = out.getContext("2d");
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, W, H);
    elements.forEach(el => drawElement(c, el));
    let dataUrl = out.toDataURL("image/png");
    if(dataUrl.length * 0.75 > 6 * 1024 * 1024) dataUrl = out.toDataURL("image/jpeg", 0.9);
    return dataUrl;
  }

  document.getElementById("drawApplyBtn").addEventListener("click", () => {
    commitText();
    if(!elements.length){ showStatus("Das Blatt ist noch leer.", "error"); return; }
    const dataUrl = exportImage();
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const name = `zeichnung-${stamp}.${dataUrl.startsWith("data:image/png") ? "png" : "jpg"}`;
    close();
    if(onDone) onDone({ name, dataUrl });
  });

  /** Oeffnet ein leeres Blatt; done({ name, dataUrl }) bekommt das fertige Bild. */
  function open(done){
    onDone = done;
    elements = [];
    history = [];
    selected = null;
    action = null;
    changed = false;
    setTool("rect");
    render();
    dialog.showModal();
  }

  return { open };
})();
