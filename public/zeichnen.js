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
    spline: "Krumme Linie zeichnen – beim Loslassen wird daraus eine glatte Kurve (Spline).",
    select: "Klick wählt ein Objekt; auf freier Fläche ziehen umrundet mehrere. Umschalt+Klick: hinzufügen/entfernen. Ziehen verschiebt, Entf löscht.",
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
  let selected = null;    // gewaehltes Element (bei Mehrfachauswahl: das zuletzt dazugekommene)
  let multi = [];         // Mehrfachauswahl (mindestens zwei Elemente), sonst leer

  /** Alle ausgewaehlten Elemente - eins, mehrere oder keins. */
  const selection = () => multi.length ? multi : (selected ? [selected] : []);
  const isSelected = (el) => el === selected || multi.includes(el);
  /** Genau dieses eine Element auswaehlen (null = nichts). */
  function selectOnly(el){ selected = el || null; multi = []; }
  /** Mehrere Elemente auswaehlen; das letzte steuert die Anzeige der Einstellungen. */
  function selectMany(list){
    const uniq = [...new Set(list)];
    if(uniq.length <= 1){ selectOnly(uniq[0]); return; }
    multi = uniq;
    selected = uniq[uniq.length - 1];
  }
  /** Liegt der Punkt innerhalb der Schlinge (Strahl-Methode)? */
  function inPolygon(pt, poly){
    let inside = false;
    for(let i = 0, j = poly.length - 1; i < poly.length; j = i++){
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if((yi > pt.y) !== (yj > pt.y) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  let action = null;      // laufende Mausaktion
  let textInput = null;   // offenes Textfeld
  let onDone = null;
  let changed = false;

  /* ---------------------------------------------------------- Hilfen */

  const opacityInput = document.getElementById("drawOpacity");
  const strokeWidth = () => Number(widthSelect.value) || 4;
  const currentOpacity = () => Math.min(100, Math.max(0, Number(opacityInput.value))) / 100;
  const cornerInput = document.getElementById("drawCorner");
  const cornerStyleSelect = document.getElementById("drawCornerStyle");
  const currentCorner = () => Math.min(100, Math.max(0, Number(cornerInput.value)));
  /* ---- Schriften fuer Text: Google Fonts (beim ersten Oeffnen geladen) + Systemschriften ---- */
  const FONT_GROUPS = [
    ["Serifenlos", ["IBM Plex Sans", "Roboto", "Open Sans", "Lato", "Montserrat", "Raleway", "Nunito", "Poppins", "Work Sans", "Oswald", "Comfortaa"]],
    ["Mit Serifen", ["Source Serif 4", "Playfair Display", "Merriweather", "Lora", "Libre Baskerville", "EB Garamond", "Cinzel"]],
    ["Handschrift", ["Caveat", "Dancing Script", "Pacifico", "Great Vibes", "Indie Flower", "Shadows Into Light", "Satisfy", "Kalam", "Permanent Marker", "Amatic SC"]],
    ["Auffällig", ["Lobster", "Bebas Neue", "Righteous", "Abril Fatface", "Bangers", "Special Elite", "Press Start 2P"]],
    ["Systemschriften", ["Arial", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New", "Impact", "Comic Sans MS"]],
  ];
  const SYSTEM_FONTS = new Set(FONT_GROUPS[FONT_GROUPS.length - 1][1]);
  const DEFAULT_FONT = "IBM Plex Sans";
  const fontSelect = document.getElementById("drawFont");
  fontSelect.innerHTML = FONT_GROUPS.map(([group, fonts]) =>
    `<optgroup label="${group}">${fonts.map(f => `<option value="${f}">${f}</option>`).join("")}</optgroup>`).join("");
  fontSelect.value = DEFAULT_FONT;
  // Jede Option in ihrer eigenen Schrift zeigen (CSSOM - kein style-Attribut wegen CSP)
  fontSelect.querySelectorAll("option").forEach(o => { o.style.fontFamily = `"${o.value}", sans-serif`; });

  /** Google Fonts nur einmal und erst beim Oeffnen des Zeichenblatts laden. */
  let fontsRequested = false;
  function loadWebFonts(){
    if(fontsRequested) return;
    fontsRequested = true;
    const families = FONT_GROUPS.flatMap(([, f]) => f)
      .filter(f => !SYSTEM_FONTS.has(f) && f !== "IBM Plex Sans" && f !== "Source Serif 4")
      .map(f => `family=${encodeURIComponent(f).replace(/%20/g, "+")}`).join("&");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
  }
  /** Schrift fuer den Canvas sicher laden; danach neu zeichnen. */
  function ensureFont(family){
    if(!document.fonts || SYSTEM_FONTS.has(family)) return Promise.resolve();
    return document.fonts.load(`40px "${family}"`).then(() => { if(dialog.open) render(); }).catch(() => {});
  }
  /** CSS-Font eines Textes; die Standardschrift wie bisher halbfett. */
  function textFont(el){
    const family = el.font || DEFAULT_FONT;
    return `${family === DEFAULT_FONT ? 600 : 400} ${el.size}px "${family}", system-ui, sans-serif`;
  }

  /* ---- Fuellung fuer Kreis, Quadrat/Rechteck, Dreieck ---- */
  const SHAPES = new Set(["rect", "ellipse", "triangle"]);
  const fillTypeSelect = document.getElementById("drawFillType");
  const fillC1 = document.getElementById("drawFillC1");
  const fillC2 = document.getElementById("drawFillC2");
  const fillDirSelect = document.getElementById("drawFillDir");
  /** Fuellung als eigenes (unveraenderliches) Objekt - Rueckgaengig bleibt sauber. */
  const currentFill = () => ({ type: fillTypeSelect.value, c1: fillC1.value, c2: fillC2.value, dir: fillDirSelect.value });

  /* ---- Schriftgroesse: eigenes Zahlenfeld, Einzelschritte ---- */
  const fontSizeInput = document.getElementById("drawFontSize");
  const textSize = () => Math.min(400, Math.max(6, Math.round(Number(fontSizeInput.value) || 32)));

  /* ---- WordArt: Verformung, Farben, Kontur, Schatten ---- */
  const waShape = document.getElementById("drawWaShape");
  const waAmount = document.getElementById("drawWaAmount");
  const waFill = document.getElementById("drawWaFill");
  const waC1 = document.getElementById("drawWaC1");
  const waC2 = document.getElementById("drawWaC2");
  const waDir = document.getElementById("drawWaDir");
  const waOutline = document.getElementById("drawWaOutline");
  const waOutlineWidth = document.getElementById("drawWaOutlineWidth");
  const waShadow = document.getElementById("drawWaShadow");
  /** WordArt-Einstellung als eigenes (unveraenderliches) Objekt. */
  const currentWa = () => ({
    shape: waShape.value, amount: Number(waAmount.value) / 100,
    fill: waFill.value, c1: waC1.value, c2: waC2.value, dir: waDir.value,
    outline: waOutline.value, outlineWidth: Number(waOutlineWidth.value), shadow: waShadow.checked,
  });
  /** Nichts Besonderes eingestellt: Text wird wie bisher gezeichnet. */
  const isPlainWa = (wa) => !wa || (wa.shape === "none" && wa.fill === "solid" && !(wa.outlineWidth > 0) && !wa.shadow);

  /* ---- Drehen: Quadrat/Rechteck, Dreieck, Kreis, Foto ---- */
  const ROTATABLE = new Set(["rect", "ellipse", "triangle", "image"]);
  const rotateInput = document.getElementById("drawRotate");
  const HANDLE_GAP = 46;   // Abstand des Drehgriffs ueber der Form (Blatt-Punkte)
  const rad = (deg) => deg * Math.PI / 180;
  const centerOf = (el) => ({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
  function rotatePoint(p, c, angle){
    const s = Math.sin(angle), co = Math.cos(angle);
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
  }
  /** Winkel auf -180..180 Grad bringen. */
  const normDeg = (d) => { let a = ((d + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
  /** Position des runden Drehgriffs (ueber der Mitte der Oberkante, mitgedreht). */
  function handlePos(el){
    return rotatePoint({ x: el.x + el.w / 2, y: el.y - 8 - HANDLE_GAP }, centerOf(el), rad(el.rotation || 0));
  }

  /** Gemeinsame Eigenschaften neuer Objekte: Farbe, Staerke, Deckkraft, Ecken, Fuellung, Schrift, WordArt. */
  const newStyle = () => ({
    color: colorInput.value, width: strokeWidth(), opacity: currentOpacity(),
    corner: currentCorner(), cornerStyle: cornerStyleSelect.value,
    fill: currentFill(), font: fontSelect.value, wa: currentWa(), rotation: 0,
  });

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

  /* ---------------------------------------------------------- Spline */

  /** Punktreihe vereinfachen (Ramer-Douglas-Peucker): Zittern weg, Form bleibt. */
  function simplify(points, epsilon){
    if(points.length < 3) return points.map(p => [...p]);
    const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
    let maxDist = -1, index = 0;
    for(let i = 1; i < points.length - 1; i++){
      const d = distToSegment({ x: points[i][0], y: points[i][1] }, { x: ax, y: ay }, { x: bx, y: by });
      if(d > maxDist){ maxDist = d; index = i; }
    }
    if(maxDist <= epsilon) return [[ax, ay], [bx, by]];
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }

  /** Gleitender Mittelwert: nimmt das Zittern der Hand heraus, Anfang und Ende bleiben. */
  function smooth(points, radius){
    if(points.length < 3) return points.map(p => [...p]);
    return points.map((p, i) => {
      if(i === 0 || i === points.length - 1) return [...p];
      let sx = 0, sy = 0, n = 0;
      for(let k = Math.max(0, i - radius); k <= Math.min(points.length - 1, i + radius); k++){
        sx += points[k][0]; sy += points[k][1]; n++;
      }
      return [sx / n, sy / n];
    });
  }

  /** Punkte in gleichem Abstand entlang der Linie (fuer gleichmaessige Kruemmung). */
  function resample(points, spacing){
    const out = [[...points[0]]];
    let carry = 0;
    for(let i = 1; i < points.length; i++){
      let [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      let seg = Math.hypot(bx - ax, by - ay);
      while(carry + seg >= spacing){
        const t = (spacing - carry) / seg;
        ax += (bx - ax) * t; ay += (by - ay) * t;
        out.push([ax, ay]);
        seg = Math.hypot(bx - ax, by - ay);
        carry = 0;
      }
      carry += seg;
    }
    const last = points[points.length - 1];
    const prev = out[out.length - 1];
    if(Math.hypot(last[0] - prev[0], last[1] - prev[1]) > spacing * 0.3) out.push([...last]);
    else out[out.length - 1] = [...last];
    return out;
  }

  /**
   * Aus einer krummen Freihand-Linie die Stuetzpunkte des Splines:
   * Zittern herausglaetten, Stuetzpunkte gleichmaessig verteilen (Abstand
   * waechst mit der Groesse der Linie), fast gerade Stuecke zusammenfassen.
   * Durch diese Punkte laeuft dann die glatte Catmull-Rom-Kurve.
   */
  function toSplinePoints(points){
    if(points.length < 2) return null;
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if(diag < 4) return null;
    const spacing = Math.min(70, Math.max(18, diag / 22));
    const pts = simplify(resample(smooth(smooth(points, 3), 3), spacing), 1.5);
    return pts.length >= 2 ? pts : null;
  }

  /**
   * Catmull-Rom-Spline durch alle Stuetzpunkte, als Bezier-Segmente:
   * liefert je Abschnitt [p1, Kontrollpunkt1, Kontrollpunkt2, p2].
   */
  function splineSegments(pts){
    const seg = [];
    for(let i = 0; i < pts.length - 1; i++){
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      seg.push([
        p1,
        [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
        [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
        p2,
      ]);
    }
    return seg;
  }

  /** Kurve in viele kleine Strecken zerlegt - fuer Treffer und Rahmen. */
  function flattenSpline(pts){
    if(pts.length < 2) return pts;
    const out = [pts[0]];
    for(const [a, b, c, d] of splineSegments(pts)){
      for(let s = 1; s <= 16; s++){
        const t = s / 16, u = 1 - t;
        out.push([
          u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
          u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
        ]);
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- Formen */

  /** Umriss einer Form als Pfad (fuer Zeichnen, Zuschneiden, Treffer). */
  function shapePath(c, el){
    c.beginPath();
    if(el.type === "rect" && el.corner > 0){
      // Ecken abflachen: corner % der halben kuerzeren Seite, rund oder schraeg
      const r = Math.min(el.w, el.h) / 2 * (el.corner / 100);
      const { x, y, w, h } = el;
      if(el.cornerStyle === "chamfer"){
        c.moveTo(x + r, y);
        c.lineTo(x + w - r, y);
        c.lineTo(x + w, y + r);
        c.lineTo(x + w, y + h - r);
        c.lineTo(x + w - r, y + h);
        c.lineTo(x + r, y + h);
        c.lineTo(x, y + h - r);
        c.lineTo(x, y + r);
        c.closePath();
      }else{
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
      }
    }else if(el.type === "rect" || el.type === "image"){
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

  /** Fuellfarbe bzw. Farbverlauf einer Form, ausgerichtet an ihrer Box - oder null. */
  function makeFill(c, el){
    const f = el.fill;
    if(!f || f.type === "none") return null;
    if(f.type === "solid") return f.c1;
    const { x, y, w, h } = el;
    let g;
    if(f.type === "radial"){
      g = c.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2);
    }else{
      const lines = { h: [x, y, x + w, y], v: [x, y, x, y + h], d: [x, y, x + w, y + h], u: [x, y + h, x + w, y] };
      g = c.createLinearGradient(...(lines[f.dir] || lines.h));
    }
    g.addColorStop(0, f.c1);
    g.addColorStop(1, f.c2);
    return g;
  }

  /* ------------------------------------------------------------ WordArt */

  /**
   * Lage eines Buchstabens in der verformten Zeile. t = Mitte des Buchstabens
   * (0..1 ueber die Zeile), cx = seine Mitte in Punkten, total = Zeilenbreite.
   * Liefert Versatz zur Grundlinie, Drehung und Skalierung.
   */
  function warpGlyph(wa, t, cx, total, size){
    const a = Math.min(1, Math.max(0, wa.amount ?? 0.5));
    const flat = { x: cx, y: 0, angle: 0, sx: 1, sy: 1 };
    switch(wa.shape){
      case "arcUp":
      case "arcDown":
      case "circle": {
        const theta = wa.shape === "circle" ? Math.PI * (1 + a) : Math.max(0.02, a * Math.PI);
        if(theta < 0.02) return flat;
        const r = total / theta;
        const phi = (t - 0.5) * theta;
        const up = wa.shape !== "arcDown";
        return { x: total / 2 + r * Math.sin(phi), y: (up ? 1 : -1) * r * (1 - Math.cos(phi)), angle: up ? phi : -phi, sx: 1, sy: 1 };
      }
      case "wave": {
        const amp = size * 0.9 * a;
        const slope = Math.cos(t * Math.PI * 2) * Math.PI * 2 * amp / total;
        return { x: cx, y: Math.sin(t * Math.PI * 2) * amp, angle: Math.atan(slope), sx: 1, sy: 1 };
      }
      case "slant":
        return { x: cx, y: -(t - 0.5) * total * a * 0.6, angle: Math.atan(-a * 0.6), sx: 1, sy: 1 };
      case "bulge": {
        const sy = 1 + a * 1.2 * Math.sin(t * Math.PI);
        return { x: cx, y: (sy - 1) * size * 0.35, angle: 0, sx: 1, sy };
      }
      case "perspective": {
        const sy = 1 - a * 0.5 + t * a * 1.5;
        return { x: cx, y: (sy - 1) * size * 0.35, angle: 0, sx: 1, sy };
      }
      default:
        return flat;
    }
  }

  /** Alle Buchstaben eines WordArt-Textes mit Lage im Blatt. */
  function layoutText(el){
    ctx.font = textFont(el);
    const lineH = el.size * 1.25;
    const glyphs = [];
    el.text.split("\n").forEach((line, li) => {
      const chars = [...line];
      const widths = chars.map(ch => ctx.measureText(ch).width);
      const total = widths.reduce((s, w) => s + w, 0) || 1;
      const baseY = el.y + li * lineH + el.size * 0.85;
      let acc = 0;
      chars.forEach((ch, i) => {
        const w = widths[i];
        const cx = acc + w / 2;
        acc += w;
        const g = warpGlyph(el.wa, cx / total, cx, total, el.size);
        glyphs.push({ ch, w, x: el.x + g.x, y: baseY + g.y, angle: g.angle, sx: g.sx, sy: g.sy });
      });
    });
    return glyphs;
  }

  /** Umgebendes Rechteck aller (gedrehten, gestreckten) Buchstaben. */
  function wordArtBox(el, glyphs){
    const pad = (el.wa.outlineWidth || 0) / 2 + 2;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for(const g of glyphs){
      const corners = [[-g.w / 2, -el.size * 0.9 * g.sy], [g.w / 2, -el.size * 0.9 * g.sy], [g.w / 2, el.size * 0.3 * g.sy], [-g.w / 2, el.size * 0.3 * g.sy]];
      for(const [lx, ly] of corners){
        const p = rotatePoint({ x: g.x + lx, y: g.y + ly }, { x: g.x, y: g.y }, g.angle);
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
      }
    }
    if(!isFinite(x1)) return { x: el.x, y: el.y, w: 1, h: el.size };
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad };
  }

  /**
   * WordArt zeichnen: Buchstaben einzeln entlang der Form. Die Fuellung
   * (eine Farbe, Verlauf, Regenbogen) entsteht auf einem Hilfsblatt, damit
   * ein Verlauf glatt ueber alle Buchstaben laeuft; der Schatten faellt auf
   * die ganze Schrift, die Kontur liegt obenauf.
   */
  function drawWordArt(c, el){
    const wa = el.wa;
    const glyphs = layoutText(el);
    if(!glyphs.length) return;
    const b = wordArtBox(el, glyphs);
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.ceil(b.w));
    off.height = Math.max(1, Math.ceil(b.h));
    const o = off.getContext("2d");
    o.translate(-b.x, -b.y);
    o.font = textFont(el);
    o.textAlign = "center";
    o.textBaseline = "alphabetic";
    glyphs.forEach((g, i) => {
      o.save();
      o.translate(g.x, g.y);
      o.rotate(g.angle);
      o.scale(g.sx, g.sy);
      o.fillStyle = wa.fill === "rainbow" ? `hsl(${Math.round(i / Math.max(1, glyphs.length - 1) * 300)}, 85%, 50%)` : (wa.c1 || el.color);
      o.fillText(g.ch, 0, 0);
      o.restore();
    });
    if(wa.fill === "gradient"){
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = "source-in";
      const grad = wa.dir === "v" ? o.createLinearGradient(0, 0, 0, off.height) : o.createLinearGradient(0, 0, off.width, 0);
      grad.addColorStop(0, wa.c1 || el.color);
      grad.addColorStop(1, wa.c2);
      o.fillStyle = grad;
      o.fillRect(0, 0, off.width, off.height);
    }
    c.save();
    if(wa.shadow){
      c.shadowColor = "rgba(0, 0, 0, 0.4)";
      c.shadowOffsetX = c.shadowOffsetY = Math.max(2, el.size * 0.06);
      c.shadowBlur = Math.max(2, el.size * 0.08);
    }
    c.drawImage(off, b.x, b.y);
    c.restore();
    if(wa.outlineWidth > 0){
      c.save();
      c.font = textFont(el);
      c.textAlign = "center";
      c.textBaseline = "alphabetic";
      c.strokeStyle = wa.outline;
      c.lineJoin = "round";
      glyphs.forEach(g => {
        c.save();
        c.translate(g.x, g.y);
        c.rotate(g.angle);
        c.scale(g.sx, g.sy);
        c.lineWidth = wa.outlineWidth / Math.max(g.sx, g.sy);
        c.strokeText(g.ch, 0, 0);
        c.restore();
      });
      c.restore();
    }
  }

  function drawElement(c, el){
    c.save();
    // Deckkraft je Objekt: 0 = unsichtbar, 1 = deckend (gilt auch fuer Fotos in Formen)
    c.globalAlpha = el.opacity ?? 1;
    c.strokeStyle = el.color;
    c.fillStyle = el.color;
    c.lineWidth = el.width;
    c.lineCap = "round";
    c.lineJoin = "round";
    if(el.type === "spline"){
      c.beginPath();
      c.moveTo(el.points[0][0], el.points[0][1]);
      for(const [, b, cc, d] of splineSegments(el.points)) c.bezierCurveTo(b[0], b[1], cc[0], cc[1], d[0], d[1]);
      c.stroke();
    }else if(el.type === "free"){
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
      if(isPlainWa(el.wa)){
        c.font = textFont(el);
        c.textBaseline = "top";
        el.text.split("\n").forEach((line, i) => c.fillText(line, el.x, el.y + i * el.size * 1.25));
      }else{
        drawWordArt(c, el);
      }
    }else{
      // Gedrehte Form: um ihre Mitte drehen - Fuellung, Foto und Umriss drehen mit
      if(ROTATABLE.has(el.type) && el.rotation){
        const m = centerOf(el);
        c.translate(m.x, m.y);
        c.rotate(rad(el.rotation));
        c.translate(-m.x, -m.y);
      }
      // Fuellung (Farbe oder Verlauf) unter einem eventuellen Foto
      const fillStyle = SHAPES.has(el.type) ? makeFill(c, el) : null;
      if(fillStyle){
        shapePath(c, el);
        c.fillStyle = fillStyle;
        c.fill();
      }
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
    if(el.type === "free" || el.type === "spline"){
      const pts = el.type === "spline" ? flattenSpline(el.points) : el.points;
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if(el.type === "text"){
      if(!isPlainWa(el.wa)) return wordArtBox(el, layoutText(el));
      ctx.font = textFont(el);
      const lines = el.text.split("\n");
      return { x: el.x, y: el.y, w: Math.max(...lines.map(l => ctx.measureText(l).width)), h: lines.length * el.size * 1.25 };
    }
    if(ROTATABLE.has(el.type) && el.rotation){
      // Gedrehte Form: Rechteck um die gedrehten Ecken
      const m = centerOf(el), a = rad(el.rotation);
      const pts = [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]]
        .map(([x, y]) => rotatePoint({ x, y }, m, a));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
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
      }else if(el.type === "free" || el.type === "spline"){
        const pts = el.type === "spline" ? flattenSpline(el.points) : el.points;
        for(let k = 1; k < pts.length; k++){
          const a = { x: pts[k - 1][0], y: pts[k - 1][1] }, b = { x: pts[k][0], y: pts[k][1] };
          if(distToSegment(p, a, b) <= tol) return el;
        }
        if(pts.length === 1 && Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= tol) return el;
      }else if(el.type === "text"){
        const b = bounds(el);
        if(p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6) return el;
      }else{
        // Gedrehte Form: Punkt zurueckdrehen und gegen die ungedrehte Form pruefen
        const q = ROTATABLE.has(el.type) && el.rotation ? rotatePoint(p, centerOf(el), -rad(el.rotation)) : p;
        shapePath(ctx, el);
        ctx.lineWidth = el.width + 16;
        if(ctx.isPointInPath(q.x, q.y) || ctx.isPointInStroke(q.x, q.y)) return el;
      }
    }
    return null;
  }

  function moveElement(el, dx, dy){
    if(el.type === "line"){ el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy; }
    else if(el.type === "free" || el.type === "spline"){ el.points.forEach(p => { p[0] += dx; p[1] += dy; }); }
    else { el.x += dx; el.y += dy; }
  }

  /* ---------------------------------------------------------- Zeichnen */

  function render(){
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    elements.forEach(el => drawElement(ctx, el));
    if(action && action.preview) drawElement(ctx, action.preview);
    // Ausgewaehlte Objekte: gestrichelter Rahmen; Drehgriff nur bei genau einer Form
    const sel = selection().filter(el => elements.includes(el));
    for(const el of sel){
      ctx.save();
      ctx.strokeStyle = "#1e88e5";
      ctx.lineWidth = 2;
      if(ROTATABLE.has(el.type)){
        const m = centerOf(el);
        ctx.translate(m.x, m.y);
        ctx.rotate(rad(el.rotation || 0));
        ctx.setLineDash([10, 6]);
        ctx.strokeRect(-el.w / 2 - 8, -el.h / 2 - 8, el.w + 16, el.h + 16);
        if(sel.length === 1){
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(0, -el.h / 2 - 8);
          ctx.lineTo(0, -el.h / 2 - 8 - HANDLE_GAP + 11);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, -el.h / 2 - 8 - HANDLE_GAP, 11, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.stroke();
          ctx.font = "16px system-ui, sans-serif";
          ctx.fillStyle = "#1e88e5";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("↻", 0, -el.h / 2 - 8 - HANDLE_GAP + 1);
        }
      }else{
        const b = bounds(el);
        ctx.setLineDash([10, 6]);
        ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16);
      }
      ctx.restore();
    }
    // Schlinge beim Umrunden
    if(action && action.kind === "lasso" && action.points.length > 1){
      ctx.save();
      ctx.beginPath();
      action.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath();
      ctx.fillStyle = "rgba(30, 136, 229, 0.08)";
      ctx.fill();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "#1e88e5";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    updateButtons();
  }

  function updateButtons(){
    document.getElementById("drawUndoBtn").disabled = history.length === 0;
    const count = selection().length;
    const delBtn = document.getElementById("drawDeleteBtn");
    delBtn.disabled = count === 0;
    delBtn.textContent = count > 1 ? `✕ ${count} Elemente löschen` : "✕ Element löschen";
    if(tool === "select") hint.textContent = count > 1
      ? `${count} Objekte ausgewählt – ziehen verschiebt alle, Entf löscht alle. Umschalt+Klick: hinzufügen/entfernen.`
      : HINTS.select;
    document.getElementById("drawClearBtn").disabled = elements.length === 0;
    const photoBtn = document.getElementById("drawPhotoBtn");
    photoBtn.textContent = selected && FILLABLE.has(selected.type) ? "🖼 Foto in Form einsetzen" : "🖼 Foto einfügen";
    syncStyleControls();
  }

  /* ------------------------------------------- Farbe und Deckkraft */

  const colorBtn = document.getElementById("drawColorBtn");
  const colorPop = document.getElementById("drawColorPop");
  const colorSwatch = document.getElementById("drawColorSwatch");
  const opacityLabel = document.getElementById("drawOpacityLabel");
  const opacityOut = document.getElementById("drawOpacityOut");
  const colorNote = document.getElementById("drawColorNote");
  const cornerWrap = document.getElementById("drawCornerWrap");
  const cornerOut = document.getElementById("drawCornerOut");
  let styleTarget = null;     // Objekt, dessen Farbe/Deckkraft gerade eingestellt wird
  let styleSnapshotDone = false;

  /** Anzeige im Farbe-Knopf; bei Auswahl zeigt er Farbe/Deckkraft dieses Objekts. */
  function syncStyleControls(){
    if(selected !== styleTarget){
      styleTarget = selected;
      styleSnapshotDone = false;
      if(selected){
        if(selected.type !== "image") colorInput.value = selected.color;
        opacityInput.value = String(Math.round((selected.opacity ?? 1) * 100));
        if(selected.type === "rect"){
          cornerInput.value = String(selected.corner ?? 0);
          cornerStyleSelect.value = selected.cornerStyle === "chamfer" ? "chamfer" : "round";
        }
        if(SHAPES.has(selected.type)){
          const f = selected.fill || { type: "none" };
          fillTypeSelect.value = f.type;
          if(f.c1) fillC1.value = f.c1;
          if(f.c2) fillC2.value = f.c2;
          if(f.dir) fillDirSelect.value = f.dir;
        }
        if(selected.type === "text"){
          fontSelect.value = selected.font || DEFAULT_FONT;
          fontSizeInput.value = String(Math.round(selected.size));
          setWaControls(selected.wa, selected.color);
        }
      }
    }
    // Drehen: nur bei einer ausgewaehlten Form; die Gradzahl folgt auch dem Drehgriff
    // Bei Mehrfachauswahl: aktiv, sobald mindestens ein passendes Objekt dabei ist
    const anySel = (pred) => selection().some(el => pred(el.type));
    const rotateOn = anySel(t => ROTATABLE.has(t));
    rotateWrap.classList.toggle("is-disabled", !rotateOn);
    rotateInput.disabled = !rotateOn;
    if(rotateOn && document.activeElement !== rotateInput) rotateInput.value = String(selected.rotation || 0);
    if(!rotateOn) rotateInput.value = "0";
    // Groesse und WordArt nur bei Text
    const textOn = selected ? anySel(t => t === "text") : tool === "text";
    fontSizeWrap.classList.toggle("is-disabled", !textOn);
    fontSizeInput.disabled = !textOn;
    waWrap.classList.toggle("is-disabled", !textOn);
    waBtn.disabled = !textOn;
    if(!textOn && !waPop.hidden) setWaPopOpen(false);
    syncWaControls();
    // Fuellung nur bei Formen, Schrift nur bei Text: Werkzeug aktiv oder solch ein Objekt ausgewaehlt
    const fillOn = selected ? anySel(t => SHAPES.has(t)) : SHAPES.has(tool);
    fillWrap.classList.toggle("is-disabled", !fillOn);
    fillBtn.disabled = !fillOn;
    if(!fillOn && !fillPop.hidden) setFillPopOpen(false);
    const fontOn = selected ? anySel(t => t === "text") : tool === "text";
    fontWrap.classList.toggle("is-disabled", !fontOn);
    fontSelect.disabled = !fontOn;
    syncFillControls();
    // Ecken nur bei Quadrat/Rechteck: Werkzeug aktiv oder ein Quadrat ausgewaehlt
    const cornersOn = selected ? anySel(t => t === "rect") : tool === "rect";
    cornerWrap.classList.toggle("is-disabled", !cornersOn);
    cornerInput.disabled = !cornersOn;
    cornerStyleSelect.disabled = !cornersOn;
    cornerOut.textContent = `${cornerInput.value} %`;
    const pct = `${opacityInput.value} %`;
    opacityLabel.textContent = pct;
    opacityOut.textContent = pct;
    colorSwatch.style.background = colorInput.value;
    colorSwatch.style.opacity = String(currentOpacity());
    colorNote.textContent = selected
      ? "Gilt für das ausgewählte Objekt und für neue Objekte."
      : "Gilt für neue Objekte. Zum Ändern eines Objekts: zuerst mit „Auswählen“ anklicken.";
  }

  /** Aenderung am ausgewaehlten Objekt - pro Einstellvorgang ein Rueckgaengig-Schritt. */
  function applyStyle(change, appliesTo = () => true){
    // Fuer alle ausgewaehlten Objekte, zu denen die Einstellung passt
    const targets = selection().filter(appliesTo);
    if(targets.length){
      if(!styleSnapshotDone){ snapshot(); styleSnapshotDone = true; }
      targets.forEach(change);
    }
    render();
  }

  colorInput.addEventListener("input", () => applyStyle(el => { if(el.type !== "image") el.color = colorInput.value; }));
  opacityInput.addEventListener("input", () => applyStyle(el => { el.opacity = currentOpacity(); }));
  // Neuer Einstellvorgang = neuer Rueckgaengig-Schritt
  colorInput.addEventListener("change", () => { styleSnapshotDone = false; });
  opacityInput.addEventListener("change", () => { styleSnapshotDone = false; });

  /* ---- Fuellung ---- */
  const fillWrap = document.getElementById("drawFillWrap");
  const fillBtn = document.getElementById("drawFillBtn");
  const fillPop = document.getElementById("drawFillPop");
  const fillSwatch = document.getElementById("drawFillSwatch");
  const FILL_LABELS = { none: "keine", solid: "Farbe", linear: "Verlauf", radial: "Verlauf rund" };
  const LINEAR_CSS = { h: "to right", v: "to bottom", d: "to bottom right", u: "to top right" };

  /** Knopf-Vorschau und sichtbare Felder je nach Art der Fuellung. */
  function syncFillControls(){
    const f = currentFill();
    document.getElementById("drawFillLabel").textContent = FILL_LABELS[f.type];
    document.getElementById("drawFillC1Label").textContent = f.type === "solid" ? "Farbe" : "von";
    document.getElementById("drawFillC1Row").hidden = f.type === "none";
    document.getElementById("drawFillC2Row").hidden = f.type === "none" || f.type === "solid";
    document.getElementById("drawFillDirRow").hidden = f.type !== "linear";
    fillSwatch.className = f.type === "none" ? "draw-fill-none" : "";
    fillSwatch.style.background = f.type === "solid" ? f.c1
      : f.type === "linear" ? `linear-gradient(${LINEAR_CSS[f.dir]}, ${f.c1}, ${f.c2})`
      : f.type === "radial" ? `radial-gradient(circle, ${f.c1}, ${f.c2})` : "";
    document.getElementById("drawFillNote").textContent = selected && SHAPES.has(selected.type)
      ? "Gilt für die ausgewählte Form und für neue Formen."
      : "Gilt für neue Formen (Kreis, Quadrat/Rechteck, Dreieck).";
  }

  const isShape = (el) => SHAPES.has(el.type);
  const applyFill = () => applyStyle(el => { el.fill = currentFill(); }, isShape);
  [fillC1, fillC2].forEach(inp => {
    inp.addEventListener("input", applyFill);
    inp.addEventListener("change", () => { styleSnapshotDone = false; });
  });
  [fillTypeSelect, fillDirSelect].forEach(sel => sel.addEventListener("change", () => {
    applyFill();
    styleSnapshotDone = false;
  }));

  function setFillPopOpen(open){
    fillPop.hidden = !open;
    fillBtn.setAttribute("aria-expanded", String(open));
    if(open) fillTypeSelect.focus();
  }
  fillBtn.addEventListener("click", () => setFillPopOpen(fillPop.hidden));

  /* ---- Schriftgroesse ---- */
  const fontSizeWrap = document.getElementById("drawFontSizeWrap");
  const isText = (el) => el.type === "text";
  fontSizeInput.addEventListener("input", () => {
    if(textInput) textInput.style.fontSize = `${textSize() * (canvas.getBoundingClientRect().width / W)}px`;
    applyStyle(el => { el.size = textSize(); }, isText);
  });
  fontSizeInput.addEventListener("change", () => { fontSizeInput.value = String(textSize()); styleSnapshotDone = false; });

  /* ---- Drehen per Gradzahl ---- */
  const rotateWrap = document.getElementById("drawRotateWrap");
  rotateInput.addEventListener("input", () => {
    const deg = normDeg(Math.round(Number(rotateInput.value) || 0));
    applyStyle(el => { el.rotation = deg; }, el => ROTATABLE.has(el.type));
  });
  rotateInput.addEventListener("change", () => { styleSnapshotDone = false; });

  /* ---- WordArt ---- */
  const waWrap = document.getElementById("drawWaWrap");
  const waBtn = document.getElementById("drawWaBtn");
  const waPop = document.getElementById("drawWaPop");
  const WA_SHAPE_LABELS = { none: "", arcUp: "Bogen oben", arcDown: "Bogen unten", circle: "Kreis", wave: "Welle", slant: "Schräg", bulge: "Aufblähen", perspective: "Perspektive" };
  /** Fertige Vorlagen - mit eigener WordArt-Farbe c1; die allgemeine "Farbe" bleibt unberuehrt. */
  const WA_PRESETS = [
    { name: "Regenbogen", wa: { c1: "#e74c3c", shape: "arcUp", amount: 0.55, fill: "rainbow", c2: "#c0392b", dir: "h", outline: "#ffffff", outlineWidth: 2, shadow: true } },
    { name: "Gold", wa: { c1: "#ffe259", shape: "perspective", amount: 0.4, fill: "gradient", c2: "#b8860b", dir: "v", outline: "#6b4e00", outlineWidth: 2, shadow: true } },
    { name: "Meereswelle", wa: { c1: "#00c6ff", shape: "wave", amount: 0.6, fill: "gradient", c2: "#0049b7", dir: "h", outline: "#002a5c", outlineWidth: 1, shadow: false } },
    { name: "Feuer", wa: { c1: "#ffd200", shape: "bulge", amount: 0.55, fill: "gradient", c2: "#e52d27", dir: "v", outline: "#7a0000", outlineWidth: 2, shadow: true } },
    { name: "Stempel", wa: { c1: "#ffffff", shape: "slant", amount: 0.45, fill: "solid", c2: "#c0392b", dir: "h", outline: "#1b1b1b", outlineWidth: 3, shadow: true } },
    { name: "Kreis", wa: { c1: "#2d2915", shape: "circle", amount: 1, fill: "solid", c2: "#c0392b", dir: "h", outline: "#ffffff", outlineWidth: 0, shadow: false } },
  ];
  document.getElementById("drawWaPresets").innerHTML = WA_PRESETS.map((p, i) =>
    `<button type="button" class="draw-wa-preset" data-preset="${i}">${p.name}</button>`).join("");

  function setWaControls(wa, fallbackColor){
    const w = wa || { shape: "none", amount: 0.5, fill: "solid", c2: waC2.value, dir: "h", outline: waOutline.value, outlineWidth: 0, shadow: false };
    waShape.value = w.shape;
    waAmount.value = String(Math.round((w.amount ?? 0.5) * 100));
    waFill.value = w.fill;
    // WordArt-Farbe: eigene, sonst (aeltere Texte, WordArt aus) die Textfarbe
    waC1.value = w.c1 || fallbackColor || colorInput.value;
    if(w.c2) waC2.value = w.c2;
    waDir.value = w.dir === "v" ? "v" : "h";
    if(w.outline) waOutline.value = w.outline;
    waOutlineWidth.value = String(w.outlineWidth || 0);
    waShadow.checked = !!w.shadow;
  }

  function syncWaControls(){
    const wa = currentWa();
    document.getElementById("drawWaLabel").textContent = isPlainWa(wa) ? "aus" : (WA_SHAPE_LABELS[wa.shape] || "an");
    document.getElementById("drawWaAmountRow").hidden = wa.shape === "none";
    document.getElementById("drawWaAmountOut").textContent = `${waAmount.value} %`;
    document.getElementById("drawWaC1Row").hidden = wa.fill === "rainbow";
    document.getElementById("drawWaC1Label").textContent = wa.fill === "gradient" ? "von" : "Farbe";
    document.getElementById("drawWaC2Row").hidden = wa.fill !== "gradient";
    document.getElementById("drawWaOutlineOut").textContent = waOutlineWidth.value;
    document.getElementById("drawWaNote").textContent = selected && selected.type === "text"
      ? "Gilt für den ausgewählten Text und für neue Texte."
      : "Gilt für neue Texte. Zum Ändern: Text mit „Auswählen“ anklicken.";
  }

  const applyWa = () => applyStyle(el => { el.wa = currentWa(); }, isText);
  [waAmount, waC1, waC2, waOutline, waOutlineWidth].forEach(inp => {
    inp.addEventListener("input", applyWa);
    inp.addEventListener("change", () => { styleSnapshotDone = false; });
  });
  [waShape, waFill, waDir, waShadow].forEach(inp => inp.addEventListener("change", () => {
    applyWa();
    styleSnapshotDone = false;
  }));
  document.getElementById("drawWaPresets").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if(!btn) return;
    const preset = WA_PRESETS[Number(btn.dataset.preset)];
    // Nur die WordArt-Farbe - die allgemeine "Farbe" bleibt, wie sie ist.
    setWaControls(preset.wa);
    applyStyle(el => { el.wa = currentWa(); }, isText);
    styleSnapshotDone = false;
  });

  function setWaPopOpen(open){
    waPop.hidden = !open;
    waBtn.setAttribute("aria-expanded", String(open));
    if(open) waShape.focus();
  }
  waBtn.addEventListener("click", () => {
    // WordArt noch aus: mit der aktuellen Textfarbe beginnen
    if(waPop.hidden && isPlainWa(currentWa()) && !(selected && selected.type === "text")) waC1.value = colorInput.value;
    setColorPopOpen(false); setFillPopOpen(false); setWaPopOpen(waPop.hidden);
  });

  /* ---- Schrift ---- */
  const fontWrap = document.getElementById("drawFontWrap");
  fontSelect.addEventListener("change", () => {
    const family = fontSelect.value;
    ensureFont(family);
    if(textInput) textInput.style.fontFamily = `"${family}", sans-serif`;
    applyStyle(el => { el.font = family; }, el => el.type === "text");
    styleSnapshotDone = false;
  });

  // Ecken abflachen (nur Quadrat/Rechteck)
  const isRect = (el) => el.type === "rect";
  cornerInput.addEventListener("input", () => applyStyle(el => { el.corner = currentCorner(); }, isRect));
  cornerInput.addEventListener("change", () => { styleSnapshotDone = false; });
  cornerStyleSelect.addEventListener("change", () => {
    applyStyle(el => { el.cornerStyle = cornerStyleSelect.value; }, isRect);
    styleSnapshotDone = false;
  });

  function setColorPopOpen(open){
    colorPop.hidden = !open;
    colorBtn.setAttribute("aria-expanded", String(open));
    if(open) opacityInput.focus();
  }

  colorBtn.addEventListener("click", () => { setFillPopOpen(false); setWaPopOpen(false); setColorPopOpen(colorPop.hidden); });
  fillBtn.addEventListener("click", () => { if(!fillPop.hidden){ setColorPopOpen(false); setWaPopOpen(false); } });
  // Klick ausserhalb schliesst das jeweilige Fenster
  document.addEventListener("pointerdown", (e) => {
    if(!colorPop.hidden && !colorBtn.parentElement.contains(e.target)) setColorPopOpen(false);
    if(!fillPop.hidden && !fillWrap.contains(e.target)) setFillPopOpen(false);
    if(!waPop.hidden && !waWrap.contains(e.target)) setWaPopOpen(false);
  });

  function setTool(name){
    commitText();
    // Spline-Knopf bei ausgewaehlter Freihand-Linie: die krumme Linie wird zur glatten Kurve.
    if(name === "spline" && selected && selected.type === "free"){
      const pts = toSplinePoints(selected.points);
      if(pts){
        snapshot();
        selected.type = "spline";
        selected.points = pts;
        showStatus("Freihand-Linie in einen Spline umgewandelt.", "success");
      }
    }
    tool = name;
    dialog.querySelectorAll(".draw-tool").forEach(b => {
      const on = b.dataset.tool === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    });
    canvas.dataset.tool = name;
    hint.textContent = HINTS[name];
    if(name !== "select") selectOnly(null);
    render();   // u.a. Regler "Ecken" je nach Werkzeug an/aus
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
      // Drehgriff der ausgewaehlten Form angefasst? (nur bei Einzelauswahl)
      if(selected && !multi.length && ROTATABLE.has(selected.type)){
        const h = handlePos(selected);
        if(Math.hypot(p.x - h.x, p.y - h.y) <= 18){
          snapshot();
          const m = centerOf(selected);
          action = { kind: "rotate", center: m, startAngle: Math.atan2(p.y - m.y, p.x - m.x), startRot: selected.rotation || 0, moved: false };
          try{ canvas.setPointerCapture(e.pointerId); }catch{ /* geht auch so */ }
          return;
        }
      }
      const hit = hitTest(p);
      if(hit && e.shiftKey){
        // Umschalt+Klick: Objekt zur Auswahl hinzufuegen bzw. herausnehmen
        const list = selection();
        selectMany(isSelected(hit) ? list.filter(el => el !== hit) : [...list, hit]);
        render();
        return;
      }
      if(hit){
        // Klick auf ein schon ausgewaehltes Objekt: alle Ausgewaehlten zusammen verschieben
        if(!isSelected(hit)) selectOnly(hit);
        snapshot();
        action = { kind: "move", last: p, moved: false };
        try{ canvas.setPointerCapture(e.pointerId); }catch{ /* z.B. Stift ohne Erfassung - geht auch so */ }
        render();
        return;
      }
      // Freie Stelle: Schlinge ziehen - alles darin wird ausgewaehlt
      action = { kind: "lasso", points: [[p.x, p.y]], add: e.shiftKey, before: e.shiftKey ? selection() : [] };
      if(!e.shiftKey) selectOnly(null);
      try{ canvas.setPointerCapture(e.pointerId); }catch{ /* geht auch so */ }
      render();
      return;
    }

    const base = newStyle();
    action = { kind: "draw", start: p, preview: null, base };
    // Spline: zuerst wie Freihand mitzeichnen, beim Loslassen glaetten.
    if(tool === "free" || tool === "spline") action.preview = { ...base, type: "free", points: [[p.x, p.y]] };
    try{ canvas.setPointerCapture(e.pointerId); }catch{ /* z.B. Stift ohne Erfassung - geht auch so */ }
    render();
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = toCanvas(e);
    if(!action){
      // Ueber dem Drehgriff: Hand als Mauszeiger
      const overHandle = tool === "select" && selected && !multi.length && ROTATABLE.has(selected.type)
        && Math.hypot(p.x - handlePos(selected).x, p.y - handlePos(selected).y) <= 18;
      canvas.classList.toggle("is-rotate-handle", !!overHandle);
      return;
    }
    if(action.kind === "rotate"){
      let deg = action.startRot + (Math.atan2(p.y - action.center.y, p.x - action.center.x) - action.startAngle) * 180 / Math.PI;
      if(e.shiftKey) deg = Math.round(deg / 15) * 15;     // Umschalt: 15-Grad-Schritte
      selected.rotation = normDeg(Math.round(deg));
      action.moved = true;
      render();
      return;
    }
    if(action.kind === "lasso"){
      action.points.push([p.x, p.y]);
      render();
      return;
    }
    if(action.kind === "move"){
      for(const el of selection()) moveElement(el, p.x - action.last.x, p.y - action.last.y);
      action.last = p;
      action.moved = true;
    }else if(tool === "free" || tool === "spline"){
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
    if(action.kind === "lasso"){
      // Ausgewaehlt wird, was innerhalb der Schlinge liegt (Mitte des Objekts)
      const poly = action.points;
      const xs = poly.map(q => q[0]), ys = poly.map(q => q[1]);
      const big = poly.length > 2 && (Math.max(...xs) - Math.min(...xs) > 6 || Math.max(...ys) - Math.min(...ys) > 6);
      const found = big ? elements.filter(el => {
        const b = bounds(el);
        return inPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, poly);
      }) : [];
      selectMany(action.add ? [...action.before, ...found] : found);
      if(multi.length) showStatus(`${multi.length} Objekte ausgewählt – gemeinsam verschieben, einstellen oder löschen.`, "info");
    }else if(action.kind === "move" || action.kind === "rotate"){
      if(!action.moved) history.pop();   // nur angeklickt: kein Rueckgaengig-Schritt
    }else if(action.preview){
      let el = action.preview;
      if(tool === "spline"){
        const pts = toSplinePoints(el.points);
        el = pts ? { ...el, type: "spline", points: pts } : null;
      }
      if(!el){ action = null; render(); return; }
      const tooSmall = (el.type === "line" && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 4)
        || (FILLABLE.has(el.type) && (el.w < 6 || el.h < 6));
      if(!tooSmall){
        snapshot();
        elements.push(el);
        // Neue Form gleich auswaehlen - so kann direkt ein Foto hinein.
        if(FILLABLE.has(el.type)) selectOnly(el);
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
    textInput.style.fontFamily = `"${fontSelect.value}", sans-serif`;
    textInput.style.fontWeight = fontSelect.value === DEFAULT_FONT ? "600" : "400";
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
    // Sofort fokussieren - auch sehr schnell Getipptes landet im Feld.
    input.focus();
    setTimeout(() => {
      if(textInput !== input) return;
      if(document.activeElement !== input) input.focus();
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
        ...newStyle(), size: textSize() });
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
      const el = { type: "image", x: (W - w) / 2, y: (H - h) / 2, w, h, img, ...newStyle() };
      elements.push(el);
      selectOnly(el);
      setTool("select");
      selectOnly(el);
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
    selectOnly(null);
    render();
  }

  /** Loescht alle ausgewaehlten Objekte auf einmal (ein Rueckgaengig-Schritt). */
  function deleteSelected(){
    const sel = selection();
    if(!sel.length) return;
    snapshot();
    elements = elements.filter(el => !sel.includes(el));
    selectOnly(null);
    render();
  }

  /** Alles auf dem Blatt auswaehlen (Strg+A im Werkzeug "Auswaehlen"). */
  function selectAll(){
    if(!elements.length) return;
    if(tool !== "select") setTool("select");
    selectMany([...elements]);
    render();
  }

  document.getElementById("drawUndoBtn").addEventListener("click", undo);
  document.getElementById("drawDeleteBtn").addEventListener("click", deleteSelected);
  document.getElementById("drawClearBtn").addEventListener("click", () => {
    if(!elements.length || !window.confirm("Das ganze Blatt leeren?")) return;
    snapshot();
    elements = [];
    selectOnly(null);
    render();
  });

  const SHORTCUTS = { s: "spline", v: "select", f: "free", l: "line", t: "text", k: "ellipse", q: "rect", d: "triangle" };
  dialog.addEventListener("keydown", (e) => {
    if(textInput || e.target.matches("input, select, textarea")) return;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); undo(); return; }
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a"){ e.preventDefault(); selectAll(); return; }
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
    if(!colorPop.hidden){ e.preventDefault(); setColorPopOpen(false); colorBtn.focus(); return; }
    if(!fillPop.hidden){ e.preventDefault(); setFillPopOpen(false); fillBtn.focus(); return; }
    if(!waPop.hidden){ e.preventDefault(); setWaPopOpen(false); waBtn.focus(); return; }
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

  document.getElementById("drawApplyBtn").addEventListener("click", async () => {
    commitText();
    if(!elements.length){ showStatus("Das Blatt ist noch leer.", "error"); return; }
    // Alle verwendeten Schriften muessen geladen sein, sonst landet eine Ersatzschrift im Bild.
    const families = [...new Set(elements.filter(el => el.type === "text").map(el => el.font || DEFAULT_FONT))];
    await Promise.all(families.map(ensureFont));
    if(document.fonts) await document.fonts.ready;
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
    selectOnly(null);
    action = null;
    changed = false;
    loadWebFonts();
    setTool("rect");
    render();
    dialog.showModal();
  }

  // Wird eine Schrift fertig geladen, das Blatt neu zeichnen (Text erscheint in der richtigen Schrift).
  if(document.fonts) document.fonts.addEventListener("loadingdone", () => { if(dialog.open) render(); });

  return { open };
})();
