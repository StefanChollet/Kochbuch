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
| `images` | Bilder als BLOB inkl. MIME-Typ, `ON DELETE CASCADE` |
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

## Zeichenblatt

Auf der Detailseite öffnet **🎨 Zeichnen** (neben *Reise löschen*, nur mit
Schreibrecht und grüner Ampel) ein grosses Fenster mit einem Blatt von
1600 × 1000 Punkten (`public/zeichnen.js`).

| Werkzeug | Bedienung |
|---|---|
| Spline (S) – ganz links | krumme Linie zeichnen; beim Loslassen wird sie geglättet und zur glatten Kurve (Catmull-Rom-Spline durch gleichmässig verteilte Stützpunkte). Ist eine Freihand-Linie ausgewählt, macht ein Klick auf *Spline* aus ihr einen Spline. |
| Auswählen (V) | Element anklicken, ziehen = verschieben, Entf = löschen |
| Freihand (F), Linie (L) | mit gedrückter Maustaste ziehen |
| Text (T) | ins Blatt klicken, tippen; Enter oder Klick daneben übernimmt (Umschalt+Enter = neue Zeile) |
| Kreis (K), Quadrat (Q), Dreieck (D) | Box aufziehen; Kreis/Quadrat mit Umschalt exakt rund/quadratisch |

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
  Die Zeichnung ist danach ein normales Bild – einzelne Elemente lassen sich
  später nicht mehr bearbeiten.

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
| `GET` | `/api/images/:id` | Bildbytes (nur für Reisen, die man sehen darf) |

Bilder: neue als `{ name, dataUrl }`, bestehende nur per `{ id }`; fehlt ein
Bild im `PUT`, ist es gelöscht. Max. 8 MB pro Bild, 32 MB pro Anfrage.

## Sichern

Server mit `Strg+C` stoppen und `travelfy.sqlite` kopieren.
