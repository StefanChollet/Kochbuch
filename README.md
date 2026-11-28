# Travelfy

Reiseverwaltung mit Übersicht und Detailseite: Reisen mit Reiseziel, Zeitraum,
Reiseart, Stationen, Reisebericht und Bildern. Aufbau und Design sind an das
Kochbuch angelehnt, die Farbwelt ist gelb. Travelfy ist eine **eigenständige
Anwendung**: eigener Server, eigene Datenbank, eigene Benutzer.

## Starten

```bash
node server.js
```

Dann http://localhost:3001/travelfy/ öffnen. Beim allerersten Start steht das
Startpasswort des Admins (`stefan`) einmalig im Server-Log.

Live läuft Travelfy auf trex hinter dem Verteiler unter
**https://chollet.corvent.ch/travelfy/** (siehe Ast `verteiler`, README dort).

| Variante | Befehl |
|---|---|
| Anderer Port | `node server.js 8081` oder `TRAVELFY_PORT=8081` |
| Andere Datenbankdatei | `TRAVELFY_DB=test.sqlite node server.js` |
| Anderer Unterpfad | `TRAVELFY_BASE=/reisen` (`""` = ohne Unterpfad) |
| Netzwerkadresse | `TRAVELFY_HOST=0.0.0.0` (Standard `127.0.0.1` = nur lokal/über nginx) |
| Startpasswort vorgeben | `TRAVELFY_ADMIN_PASSWORD=... node server.js` (nur beim ersten Start) |

### Unterpfad

Alle Adressen im Browser sind relativ (`api/...`, `reise.html`), der Server
nimmt nur Anfragen unter `/travelfy/` an. Das Cookie `travelfy_session` gilt
nur für `/travelfy/`, der Service Worker nur für diesen Bereich. Die
Sprung-Sperre prüft auf dem gemeinsamen Host den Pfad der auslösenden Seite:
erlaubt sind Travelfy selbst, Seitenaufrufe von der Startseite `/` und direkte
Aufrufe; Anfragen aus `/kochbuch/` oder anderen Apps → 403.

**Keine Abhängigkeiten** – kein `npm install`. Nur Node.js-Standardmodule inkl.
`node:sqlite`. Voraussetzung: **Node.js 22 oder neuer** (getestet mit 24.19.0).

## Aufbau

```
server.js        HTTP-Server: Sprung-Sperre, Sicherheits-Kopfzeilen, /api, public/
api.js           REST-Routen, Anmeldung (Cookie travelfy_session), Rechte
db.js            SQLite-Schema und sämtliche Datenbankzugriffe
public/
  index.html     Übersicht (Tabelle, Suche, Filter, Nächste Reisen)
  reise.html     Detailseite einer Reise (anlegen, ansehen, bearbeiten)
  login.html     Anmeldung
  common.js      gemeinsam: API, Kopfzeile, Benutzermenü, Benutzerverwaltung
  travelfy.js    Logik der Übersicht
  reise.js       Logik der Detailseite
  travelfy.css   Design (Kochbuch-Aufbau, gelbe Farbwelt, Hell/Dunkel)
  sw.js, manifest.webmanifest, icons/   PWA (installierbar)
tools/make-icons.js   erzeugt die PNG-Icons neu
travelfy.sqlite  die Datenbank (wird beim ersten Start angelegt, nicht im Repo)
```

## Datenbankschema

| Tabelle | Inhalt |
|---|---|
| `trips` | Name, Kurzbeschreibung, Reiseziel, Von/Bis (`JJJJ-MM-TT`), Reisebericht, Ersteller (`created_by` → `accounts`), Zeitstempel |
| `trip_categories` | Reiseart, höchstens eine je Reise, `ON DELETE CASCADE` |
| `stations` | Stationen (Ort + Datum/Notiz) in Reihenfolge, `ON DELETE CASCADE` |
| `images` | nur **Metadaten** der Bilder: Name, MIME-Typ, Grösse, Dateiname (`file`), Zeichenblatt-Datei (`scene_file`), Reihenfolge, Erstellzeit; `ON DELETE CASCADE` |

**Bilddaten liegen als Dateien**, nicht in der Datenbank: im Bilder-Ordner
(Standard `images/` neben der Datenbankdatei, auf trex `/web/sites/travelfy/data/images/`,
anderer Ort mit `TRAVELFY_IMAGES`). Dateiname = Bild-id + Endung, z. B.
`mx0kgk3gb4a48342.jpg`; ein Zeichenblatt hat zusätzlich `<id>.scene.json` (Objekte
samt eingesetzter Fotos). Dateien werden sicher geschrieben (Zwischenname, fsync,
umbenennen) und entfallen mit ihrem Datensatz – auch beim Löschen einer Reise oder
eines Benutzers (Aufräumen nach jeder Änderung, nur eigene Dateinamen).
Schema 3: Ältere Datenbanken mit Bilddaten in der Tabelle ziehen beim ersten Start
von selbst um (Dateien schreiben, Tabelle ohne Datenspalten neu aufbauen, `VACUUM`).
| `accounts` | Benutzer: id (0 = Admin), Name, scrypt-Passworthash, Rolle `admin`/`rw`/`r` |
| `account_sessions` | SHA-256 des Sitzungstokens, Ablaufzeit |
| `meta` | `app = travelfy`, `schema_version` |

Eine Datenbankdatei ohne die Kennung `app = travelfy` (z. B. `kochbuch.sqlite`)
lehnt der Server beim Start ab, statt sie zu benutzen.

## Benutzer und Rechte

| Rolle | Darf |
|---|---|
| `admin` (fest, id 0, Name `stefan`) | alles, inkl. Benutzerverwaltung |
| `rw` – Lesen + Schreiben | eigene Reisen anlegen, bearbeiten, löschen (sieht nur die eigenen) |
| `r` – Nur lesen | alle Reisen ansehen |

Benutzermenü oben rechts: *Benutzerverwaltung* (nur Admin), *Passwort ändern*,
*Abmelden*. Passwörter als scrypt-Hash, Sitzung 30 Tage, nach 10 Fehlversuchen
je IP 15 Minuten Sperre.

### Ampel „nur Sicht“

Neben der Überschrift („Reisen“, auf der Detailseite neben dem Reisenamen) steht für Benutzer mit Schreibrecht (Admin, Lesen + Schreiben)
ein Ampelknopf; wer nur lesen darf, sieht ihn nicht.

| Ampel | Wirkung auf Übersicht, Detailseiten und Funktionen |
|---|---|
| **Rot = nur Sicht** | Alles nur zum Ansehen: kein *Reise erfassen*, kein Bearbeiten oder Löschen, Detailseiten gesperrt, keine Benutzerverwaltung. *Passwort ändern* und *Abmelden* bleiben. |
| **Grün = Rechte der Rolle** | Es gelten die Rechte des Benutzers: Admin alles inkl. Benutzerverwaltung, Lesen + Schreiben die eigenen Reisen. |

- Nach jeder Anmeldung und in jedem neuen Tab steht die Ampel auf **Rot**.
- Grün gilt auf allen Seiten bis zum Abmelden; Neuladen behält Grün (sessionStorage).
- Wechsel auf Rot mit ungespeicherten Änderungen auf der Detailseite: Rückfrage,
  danach wird der gespeicherte Stand neu geladen. Eine neue, noch nicht
  gespeicherte Reise führt bei Rot zurück zur Übersicht.
- Reine Anzeige-Sperre – die Rechte prüft der Server unabhängig davon.

## Bilder sofort speichern

Ein hochgeladenes **Foto** und ein mit *In Bilder übernehmen* fertiges
**Zeichenblatt** gehen sofort an den Server und liegen damit dauerhaft in der
Server auf trex (Bilddatei in `/web/sites/travelfy/data/images/`, Metadaten in `travelfy.sqlite`) –
nicht erst mit *Speichern* der Reise. Auch *Abbrechen*, Schliessen des Fensters
oder ein Absturz danach lassen sie bestehen.

- Während des Hochladens zeigt das Bild **„Speichert…“**, danach meldet die
  Statuszeile „… ist dauerhaft gespeichert“.
- Ein **bearbeitetes Zeichenblatt** ersetzt das bisherige sofort an derselben Stelle
  und behält seine Erstellzeit (neue Bild-id, weil Bild-Adressen unveränderlich
  zwischengespeichert werden).
- **Neue Reise:** Hat sie schon einen Namen, wird sie beim ersten Bild automatisch
  angelegt (samt allen bisherigen Eingaben); die Seite arbeitet danach mit
  `?id=` weiter. Ohne Namen bleibt das Bild **„nicht gespeichert“** vorgemerkt,
  bis ein Name da ist und ein weiteres Bild kommt oder *Speichern* gedrückt wird.
- Klappt das Sofort-Speichern nicht (z. B. keine Verbindung), bleibt das Bild
  „nicht gespeichert“ vorgemerkt und geht mit *Speichern* noch einmal mit.
- **Entfernen** (✕ oder Kontextmenü *Bild entfernen*) löscht ein gespeichertes Bild
  bzw. Zeichenblatt nach einer Rückfrage **sofort endgültig** aus der Datenbank
  (`DELETE /api/images/:id`); während des Löschens zeigt es „Löscht…“. Ein nur
  vorgemerktes Bild wird einfach weggelassen.
- **Ändern** eines Zeichenblatts (*✎ Bearbeiten* → *Änderungen übernehmen*):
  die alte Fassung wird sofort gelöscht und die neue an ihrer Stelle gespeichert.
- **Umordnen und Sortieren** werden sofort gespeichert (`PUT /api/trips/:id/image-order`);
  bei schnellen Folgeänderungen geht nur die letzte an den Server.
- **Speichern der Reise löscht nie ein Bild.** Es sichert Texte, Reiseart und
  Stationen und hängt höchstens noch vorgemerkte Bilder an. Eine veraltete Seite
  (zweiter Tab, anderes Gerät) kann so keine inzwischen gespeicherten Bilder entfernen.
- Die Bild-Auswahl zählt nicht als ungespeicherte Änderung (*Abbrechen* fragt nicht).
- Uploads laufen nacheinander (Warteschlange); *Speichern* wartet sie ab, so
  entstehen keine doppelten Bilder.

## Bilder ordnen

Die Reihenfolge im Block *Bilder* ist die gespeicherte Reihenfolge
(`images.position`); jede Änderung wird **sofort** gespeichert (siehe oben).

- **Ziehen und Ablegen:** ein Bild mit der Maus an eine andere Stelle ziehen – ein
  gelber Balken zeigt, wo es landet. Von aussen hereingezogene Dateien lösen kein
  Umordnen aus.
- **Kontextmenü** (Rechtsklick, Knopf **⋯** oben links am Bild – praktisch auf dem
  Handy –, oder Taste *Kontextmenü* bzw. Umschalt+F10 am Bild):
  - *Neu anordnen:* an den Anfang, einen Platz nach vorne/hinten, ans Ende
  - *Alle Bilder sortieren:* älteste/neueste zuerst (Entstehungszeit wie in der
    Dia-Show; noch ungespeicherte Bilder kommen ans Ende), Name A–Z / Z–A
    (natürliche Sortierung: „Bild 2“ vor „Bild 10“)
  - Vergrössern, Zeichenblatt bearbeiten, Bild entfernen
- **Tastatur:** Tab wählt ein Bild, Enter vergrössert, Alt+Pfeil verschiebt um einen
  Platz, Alt+Pos1/Ende an den Anfang/ans Ende; im Menü Pfeiltasten, Enter, Esc.
- Bei roter Ampel oder nur Leserecht: kein Ziehen, im Menü nur *Vergrössern*.
- Die **Dia-Show** spielt die Bilder genau in dieser Reihenfolge ab (auch schon vor
  dem Speichern). Chronologisch: vorher *Älteste zuerst* wählen.

## Dia-Show

Auf der Detailseite ganz unten links: **▶ Dia-Show erstellen** (`public/diashow.js`) –
auch bei roter Ampel, weil sie nur anzeigt.

1. **Einstellungen:** alle Bilder der Reise – Fotos und mit *Zeichnen* erstellte
   Zeichenblätter – in der Reihenfolge des Blocks *Bilder* (siehe
   [Bilder ordnen](#bilder-ordnen)), als nummerierte Leiste. Einstellbar: **Anzeige pro Bild** (Standard 10 s),
   **Übergang** (Standard 2 s, 0 = harter Schnitt) und **Art des Übergangs**
   (Überblenden, Schieben, Zoomen). Die Werte werden im Browser gemerkt.
2. **Starten:** Vollbild, jedes Bild so gross wie möglich (Seitenverhältnis bleibt),
   in einer **Endlosschleife** – die Show endet nur von Hand: **⏹ Stopp** oder **Esc**
   (bzw. Vollbild verlassen). **⏸/▶** oder Leertaste pausiert und setzt fort,
   **⏮ ⏭** bzw. ← → blättern. Die Bedienleiste und der Mauszeiger blenden sich nach
   4 s Ruhe aus; Maus bewegen holt sie zurück. Der Bildschirm bleibt während der
   Show an (Wake Lock, wo der Browser es kann).
3. Danach lässt sich die Show beliebig oft neu starten.

## Zeichenblatt

Auf der Detailseite öffnet **🎨 Zeichnen** (neben *Reise löschen*, nur mit
Schreibrecht und grüner Ampel) ein grosses Fenster mit einem Blatt von
1600 × 1000 Punkten (`public/zeichnen.js`).

| Werkzeug | Bedienung |
|---|---|
| Spline (S) – ganz links | krumme Linie zeichnen; beim Loslassen wird sie geglättet und zur glatten Kurve (Catmull-Rom-Spline durch gleichmässig verteilte Stützpunkte). Ist eine Freihand-Linie ausgewählt, macht ein Klick auf *Spline* aus ihr einen Spline. |
| Auswählen (V) | Klick wählt ein Objekt. **Umrunden:** auf freier Fläche eine Schlinge um mehrere Objekte ziehen – alles, dessen Mitte darin liegt, wird ausgewählt (mit Umschalt: zur Auswahl dazu). **Umschalt+Klick** fügt ein Objekt hinzu oder nimmt es heraus, **Strg+A** wählt alles, Klick ins Leere hebt die Auswahl auf. Ziehen verschiebt alle Ausgewählten, Entf löscht alle; Farbe, Deckkraft, Füllung, Ecken, Schrift, WordArt und Drehen gelten für alle passenden Objekte der Auswahl (ein Rückgängig-Schritt). Der Drehgriff erscheint nur bei einer einzelnen Form. **Gruppieren** (Knopf ⛓ oder Strg+G) fasst die Auswahl zu einer Gruppe zusammen: ein Klick auf ein Teil wählt die ganze Gruppe (Rahmen „⛓ Gruppe“), sie wird gemeinsam verschoben, eingestellt und gelöscht; *Gruppierung aufheben* (Strg+Umschalt+G) löst sie wieder. Gruppiert man Gruppen, gehen sie in der neuen auf. |
| Freihand (F), Linie (L) | mit gedrückter Maustaste ziehen |
| Text (T) | ins Blatt klicken, tippen; Enter oder Klick daneben übernimmt (Umschalt+Enter = neue Zeile) |
| Kreis (K), Quadrat (Q), Dreieck (D) | Box aufziehen; Kreis/Quadrat mit Umschalt exakt rund/quadratisch |
| Gummi (E) | über das Blatt fahren radiert alles darunter weg – Linien, Formen, Text und Fotos. Ein Kreis zeigt die Gummi-Grösse. **Mausrad** über dem Blatt stellt sie stufenlos ein (hoch = grösser, runter = kleiner; mit Umschalt feinere Schritte; 4–300 Punkte, aktueller Wert im Hinweis); eine Wahl bei *Stärke* setzt sie auf Stärke × 5 (fein 10 … sehr dick 70). Strg+Mausrad bleibt Browser-Zoom. Ein Zug = ein Rückgängig-Schritt. |
| Schere (X) | einen Bereich umfahren (mit Umschalt: Rechteck aufziehen). Was darin liegt, wird aus den Objekten herausgeschnitten und als **eigenes Stück** (Bild, knapp auf den Inhalt zugeschnitten, bis doppelte Auflösung) obenauf gelegt – es ist danach ausgewählt und lässt sich verschieben, vergrössern, drehen oder löschen. |

Gummi und Schere radieren nicht in ein flaches Bild, sondern geben jedem
getroffenen Objekt eine **Radiermaske** (`erase` im gespeicherten Inhalt:
Gummi-Striche bzw. Schnittflächen im eigenen Rahmen des Objekts). Die Maske
wandert beim Verschieben, Vergrössern und Drehen mit; das Objekt bleibt
bearbeitbar (Farbe, Füllung, Text …), auch nach dem Speichern und erneuten
*Bearbeiten*. Radierte Stellen zählen beim Anklicken weiter zum Objekt.

- **Farbe und Deckkraft** stecken im Knopf *Farbe*: Farbwahl und Regler
  0–100 % (0 % = unsichtbar, 100 % = deckend). Sie gelten für neue Elemente und
  für das ausgewählte Element – so lässt sich jedes Objekt einzeln einstellen,
  auch Fotos in Formen. Jeder Einstellvorgang ist ein Rückgängig-Schritt.
- **Füllung** (Kreis, Quadrat/Rechteck, Dreieck): Knopf *Füllung* mit Art
  *keine*, *Farbe*, *Farbverlauf (linear)* in vier Richtungen (→ ↓ ↘ ↗) oder
  *Farbverlauf (rund)*, je zwei Farben. Die Füllung liegt unter einem Foto in der
  Form und unter dem Umriss; Deckkraft wirkt auch auf sie.
- **Schrift** (Text): Auswahl aus über 40 Schriften, gruppiert nach Serifenlos,
  mit Serifen, Handschrift, Auffällig und Systemschriften – jede Option in ihrer
  eigenen Schrift. Die Google-Schriften werden erst beim ersten Öffnen des
  Zeichenblatts geladen; vor *In Bilder übernehmen* wartet das Blatt, bis alle
  verwendeten Schriften da sind.
- **Grösse** (Text): Schriftgrösse 6–400 als Zahl, mit Pfeiltasten bzw. den
  Pfeilen im Feld in Einzelschritten.
- **✨ WordArt** (Text): Text verformen – *Bogen oben*, *Bogen unten*, *Kreis*,
  *Welle*, *Schräg*, *Aufblähen*, *Perspektive* mit Stärke 0–100 %; Farben *eine
  Farbe*, *Verlauf* (waagrecht/senkrecht, von der WordArt-Farbe bis zu einer zweiten
  Farbe) oder *Regenbogen*; *Kontur* (Farbe, Breite 0–12) und *Schatten*. Sechs
  Vorlagen (Regenbogen, Gold, Meereswelle, Feuer, Stempel, Kreis) setzen alles auf
  einmal. Die Buchstaben werden einzeln entlang der Form gesetzt; der Verlauf
  läuft glatt über den ganzen Schriftzug.
  WordArt hat eine **eigene Farbe**: Vorlagen ändern nur sie, nie die allgemeine
  *Farbe*. Ist WordArt aus, hat der Text wieder seine normale Farbe – ein heller
  Vorlagen-Ton (z. B. Weiss bei „Stempel“) kann so keinen späteren Text unsichtbar machen.
- **Drehen** (Quadrat/Rechteck, Dreieck, Kreis, Foto): am runden Griff ↻ über der
  ausgewählten Form ziehen (Umschalt = 15°-Schritte) oder Gradzahl −180…180 im
  Feld *Drehen*. Füllung, Foto und abgeflachte Ecken drehen mit.
- **Grösse ändern** (Werkzeug *Auswählen*): an den 8 Anfassern rund um die Auswahl
  ziehen – Ecken ändern Breite und Höhe, Kantenmitten nur eine Richtung; die
  gegenüberliegende Seite bleibt stehen. Bei einer gedrehten Form drehen die Anfasser
  mit. Umschalt hält das Seitenverhältnis; Text (Schriftgrösse wächst mit, Feld
  *Grösse* zieht nach), mehrere Objekte und Gruppen werden immer proportional
  skaliert. Linien, Freihand und Splines werden mitsamt ihren Punkten gestreckt.
  Die aktuelle Grösse steht im Hinweis; ein Rückgängig-Schritt pro Zug.
- Füllung und Schrift gelten wie Farbe/Deckkraft für neue und für das ausgewählte
  Objekt und sind nur aktiv, wenn sie zum Werkzeug bzw. zum ausgewählten Objekt passen.
- **Ecken abflachen** (nur Quadrat/Rechteck): Regler *Ecken* 0–100 % (Anteil der
  halben kürzeren Seite; 100 % = ganz rund bzw. Achteck) und Art *rund* oder
  *schräg*. Aktiv, solange das Werkzeug *Quadrat* gewählt oder ein Quadrat
  ausgewählt ist; gilt wie Farbe/Deckkraft für neue und für das ausgewählte
  Quadrat. Fotos darin werden mit zugeschnitten.
- Stärke gilt für neue Elemente (bestimmt auch die Textgrösse).
- **Fotos in Formen:** eine Form auswählen (neu gezeichnete Formen sind gleich
  ausgewählt), dann *Foto in Form einsetzen* oder **Strg+V** – das Foto füllt die
  Form und wird auf Kreis, Quadrat oder Dreieck zugeschnitten. Ohne gewählte Form
  wird das Foto ein eigenes, verschiebbares Element.
- Rückgängig (Strg+Z), Element löschen, Alles leeren.
- **In Bilder übernehmen** legt die Zeichnung als PNG (bei sehr grossen Fotos
  JPEG) bei den Bildern der Reise ab; gesichert wird sie mit *Speichern*.
- **Wieder bearbeiten:** Mit dem Bild wird der Inhalt des Blatts gespeichert
  (alle Objekte mit ihren Eigenschaften, Gruppen, eingesetzte Fotos – jedes Foto
  nur einmal; Datei `<id>.scene.json`, max. 20 MB). **✎ Bearbeiten** (nur mit
  Schreibrecht und grüner Ampel) öffnet das Blatt mit allen Objekten,
  *Änderungen übernehmen* ersetzt das Bild sofort an derselben Stelle; Name und
  **Erstellzeit** bleiben, damit die Reihenfolge in der Dia-Show gleich bleibt.
- **Fotos bearbeiten** (z. B. Titel einfügen): **✎ Bearbeiten** gibt es an *jedem*
  Bild. Ein Foto öffnet sich als Hintergrund eines Blatts **in seinem Format**
  (lange Seite 1600 Punkte) und in **voller Auflösung** (bis 2 Pixel je Punkt, z. B.
  2400 × 1800 bleibt 2400 × 1800); das Text-Werkzeug ist gleich aktiv. Das Ergebnis
  wird als JPEG gespeichert und bleibt als Zeichenblatt weiter bearbeitbar.
- **Original bleibt erhalten:** Beim ersten Bearbeiten eines Fotos merkt sich die
  Datenbank dessen Datei (`images.original_file`, `original_mime`, `original_name`);
  weitere Bearbeitungen reichen das Original weiter. **↺ Original** (am Bild oder im
  Kontextmenü) verwirft nach einer Rückfrage alle Bearbeitungen und stellt das
  Originalbild sofort wieder her – byte-genau, mit Name und Erstellzeit
  (`POST /api/images/:id/restore`). Schema 4 ergänzt die Spalten beim ersten Start. Zeichenblätter von vor dieser Funktion sind nur als Bild
  vorhanden und lassen sich nicht mehr in Objekte zerlegen.
- Schema 2 der Datenbank (`images.scene`, `images.created_at`) wird beim ersten
  Start automatisch ergänzt; vorhandene Daten bleiben unverändert.
  Inhalt eines Zeichenblatts abrufen: `GET /api/images/:id/scene`.

## Versionsnummer

Unten links auf jeder Seite steht die Version, z. B. **„Version 1.24“**
(`public/version-anzeige.js`). Tooltip: Commit und Datum.

- Die Nummer kommt aus Git: `1.<Anzahl Commits>`. Jede Änderung ist ein Commit,
  die Nummer steigt also von selbst.
- Auf trex schreibt `deploy/einspielen.sh` (Verteiler) beim Einspielen
  `version.json` neben `server.js` (Nummer, Kurz-Hash, Commit-Datum). Lokal ohne
  diese Datei liest der Server Git direkt; mit ungespeicherten Änderungen
  erscheint `+dev`.
- `version.js` erzeugt der Server (`self.APP_VERSION`); `GET api/version` liefert
  die laufende Version (öffentlich, nie zwischengespeichert).
- Läuft auf dem Server schon eine neuere Version als die offene Seite, wird die
  Anzeige hervorgehoben: „Version 1.24 – neu: 1.25 · neu laden“ – ein Klick lädt
  die aktuelle Fassung. Geprüft wird beim Laden, beim Zurückkehren zum Tab und
  alle 5 Minuten.
- Der Cache-Name des Service Workers enthält die Version (Platzhalter
  `__BUILD__` in `sw.js`, vom Server ersetzt) – kein Hochzählen von Hand mehr.

## Trennung von Kochbuch (Sprung-Sperre)

Ein Wechsel zwischen Kochbuch und Travelfy ist auf Travelfy-Seite unterbunden:

| Maßnahme | Wirkung |
|---|---|
| Sprung-Sperre im Server (`Sec-Fetch-Site`, ersatzweise `Origin`/`Referer`) | Jede Anfrage, die eine andere Anwendung auslöst – Link, Formular, Bild, Skript, iframe – bekommt `403 Wechsel gesperrt`. Erlaubt sind nur Aufrufe aus Travelfy selbst und direkte Aufrufe (Adresszeile, Lesezeichen, installierte App). Die Sperrseite enthält bewusst keinen Link. |
| `Content-Security-Policy` mit `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'`; `X-Frame-Options: DENY` | Travelfy lässt sich nirgends einbetten und schickt nichts an andere Server. |
| `Cross-Origin-Opener-Policy` und `Cross-Origin-Resource-Policy: same-origin` | Kein Fenstergriff zwischen den Apps; Travelfy-Bilder laden nur in Travelfy. |
| `Referrer-Policy: same-origin` | Verlässt man Travelfy, erfährt das Ziel nicht, woher man kommt. |
| Link-Sperre im Browser (`common.js`) | Links auf eine andere Herkunft (anderer Host oder Port) werden nicht geöffnet. Travelfy enthält keine Links zum Kochbuch. |
| Eigenes Cookie `travelfy_session`, `SameSite=Strict` | Cookies unterscheiden nicht nach Port – mit eigenem Namen überschreibt sich nichts, und von außen kommend wird die Sitzung gar nicht erst mitgeschickt. |
| Rücksprung nach der Anmeldung nur auf eigene Seiten (`safeNext`) | `?next=` kann nicht auf eine fremde Adresse führen. |
| Eigene Datenbank, eigener Port (3001), eigene Benutzer | Eine Kochbuch-Anmeldung gilt in Travelfy nicht und umgekehrt. |
| Nur `application/json` bei schreibenden Anfragen | Ein einfaches HTML-Formular einer anderen Seite kann nichts ändern. |

Die Gegenrichtung (Travelfy → Kochbuch) blockiert zusätzlich nur das Kochbuch
selbst, wenn es dieselbe Sprung-Sperre bekommt.

## API

Basis `/api`, JSON. Fehler als `{ "error": "..." }`.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/health` | Status (ohne Anmeldung) |
| `GET` | `/api/auth/users` | Benutzernamen für die Anmeldung |
| `GET` | `/api/auth/status` | angemeldeter Benutzer oder `null` |
| `POST` | `/api/auth/login` · `/api/auth/logout` · `/api/auth/password` | Anmelden, Abmelden, eigenes Passwort |
| `GET` `POST` | `/api/users` | Benutzer auflisten / anlegen (Admin) |
| `PATCH` `DELETE` | `/api/users/:id` | Rechte ändern / Benutzer samt Reisen löschen (Admin) |
| `POST` | `/api/users/:id/password` | Passwort eines Benutzers neu setzen (Admin) |
| `GET` | `/api/state` | Vorschläge für die Reiseart |
| `GET` | `/api/trips` | Übersicht: `search`, `category` (`-` = ohne), `createdBy`, `fromDate`, `sortBy` (`name`, `destination`, `startDate`, `updatedAt`, `createdBy`), `sortDir`, `page`, `pageSize` |
| `GET` | `/api/trip-filters` | Auswahl für die Filter |
| `POST` | `/api/trips` | Reise anlegen |
| `GET` `PUT` `DELETE` | `/api/trips/:id` | Reise lesen / ersetzen / löschen |
| `POST` | `/api/trips/:id/images` | ein Bild sofort speichern: `{ name, dataUrl, scene?, createdAt?, replaces? }` – angehängt, oder mit `replaces` an der Stelle dieses Bildes (Erstellzeit bleibt) |
| `PUT` | `/api/trips/:id/image-order` | Reihenfolge sofort speichern: `{ ids: [...] }` – nicht genannte Bilder bleiben dahinter, nichts wird gelöscht |
| `GET` | `/api/images/:id` | Bildbytes (nur für Reisen, die man sehen darf) |
| `DELETE` | `/api/images/:id` | ein Bild sofort endgültig löschen |

Bilder: beim Anlegen (`POST /api/trips`) als `images: [{ name, dataUrl }]`. Beim
`PUT` bleiben die Bilder unberührt; `addImages: [{ name, dataUrl }]` hängt noch
vorgemerkte an. (Die alte Komplett-Liste `images` im `PUT` wird weiter verstanden:
dort gilt ein fehlendes Bild als gelöscht.) Max. 8 MB pro Bild, 32 MB pro Anfrage.

## Sichern

Server mit `Strg+C` stoppen und `travelfy.sqlite` **und den Ordner `images/`** kopieren –
beides gehört zusammen. Auf trex sichert `deploy/einspielen.sh` (Verteiler) bei jedem
Einspielen die Datenbank (`*.bak-vor-update-<zeit>`) und den Bilder-Ordner per Hardlinks
(`images.bak-vor-update-<zeit>`, kostet keinen zusätzlichen Platz).
