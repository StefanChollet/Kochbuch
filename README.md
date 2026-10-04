# Kochbuch

Rezeptverwaltung mit Zutatenlisten, Bildern und Kühlschrank-Bestand.
Die Daten liegen in einer SQLite-Datenbank auf dem Server, der Browser greift
über eine REST-API darauf zu.

## Starten

```bash
node server.js
```

Dann http://localhost:3000/ öffnen.

| Variante | Befehl |
|---|---|
| Anderer Port | `node server.js 8080` |
| Andere Datenbankdatei | `KOCHBUCH_DB=test.sqlite node server.js` |

**Keine Abhängigkeiten** – kein `npm install`, kein `node_modules`. Das Projekt
nutzt ausschließlich Node.js-Standardmodule, inklusive des eingebauten
SQLite-Treibers `node:sqlite`. Voraussetzung ist **Node.js 22 oder neuer**
(getestet mit 24.19.0).

## Aufbau

```
server.js               HTTP-Server: /api an die API, alles andere aus public/
api.js                  REST-Routen, JSON-Ein-/Ausgabe, Fehlerübersetzung
db.js                   SQLite-Schema und sämtliche Datenbankzugriffe
public/                 alles, was der Browser bekommt
  kochbuch.html
  kochbuch.css
  kochbuch.js
kochbuch.sqlite         die Datenbank (wird beim ersten Start angelegt)
```

Die Client-Dateien liegen bewusst in `public/`: ausgeliefert wird nur, was
dort steht. `db.js`, `api.js` und die Datenbankdatei sind damit über HTTP
nicht erreichbar.

## Datenbankschema

| Tabelle | Inhalt |
|---|---|
| `recipes` | Kopfdaten: Name, Kurzbeschreibung, Zubereitungstext, Kategorie (genau eine oder leer), Besitzer (`owner_id` → `users`), Zeitstempel |
| `ingredients` | Zutaten, `recipe_id` → `recipes`, `ON DELETE CASCADE`, Reihenfolge über `position` |
| `images` | Bilder als BLOB inkl. MIME-Typ, `recipe_id` → `recipes`, `ON DELETE CASCADE` |
| `fridge_items` | Kühlschrank-Bestand |
| `ingredient_catalog` | Vorschlagsliste, Primärschlüssel `COLLATE NOCASE` (»Mehl« = »mehl«) |
| `meta` | u. a. `schema_version` (aktuell 2) |
| `users` | Benutzer: Name (`COLLATE NOCASE`), scrypt-Passworthash, Admin-Flag |
| `sessions` | Anmeldungen: SHA-256 des Sitzungstokens, Ablaufzeit; `ON DELETE CASCADE` mit dem Benutzer |
| `recipe_shares` | Freigaben: Rezept × Benutzer, `can_write` 0 = nur lesen, 1 = bearbeiten |

Ein gelöschtes Rezept nimmt seine Zutaten und Bilder per Fremdschlüssel mit.
`PRAGMA foreign_keys = ON` ist gesetzt, `journal_mode = WAL`.

### Bilder

Bilder liegen als Bytes in der Datenbank, nicht als Base64 im Datensatz.
Beim Anlegen oder Ändern eines Rezepts schickt der Client neue Bilder als
Data-URL; die Antwort enthält danach nur noch Metadaten plus eine `url`:

```json
{ "id": "mtx0dp13...", "name": "titel.png", "mime": "image/png", "bytes": 222,
  "url": "/api/images/mtx0dp13..." }
```

Der Browser lädt die Bytes getrennt über diese URL. Weil eine Bild-id immer
genau einen unveränderlichen Inhalt bezeichnet, wird sie dauerhaft gecacht
(`immutable` + ETag).

**Wichtig beim Aktualisieren:** bereits gespeicherte Bilder werden nur über
ihre `id` referenziert, nicht erneut hochgeladen. Ein Bild, das im `images`-Array
eines `PUT` fehlt, gilt als gelöscht.

Obergrenzen: 8 MB pro Bild, 32 MB pro Anfrage.

## API

Basis: `/api`. Alle Antworten sind JSON (UTF-8), außer der Bildauslieferung.
Fehler kommen einheitlich als `{ "error": "..." }` mit passendem HTTP-Status
(400 ungültige Eingabe, 404 nicht gefunden, 405 falsche Methode,
409 id vergeben, 413 zu groß, 415 kein Bild, 500 Serverfehler).

### Überblick

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/health` | Status und Schema-Version (ohne Anmeldung) |
| `GET` | `/api/auth/status` | angemeldeter Benutzer, `setupRequired` (ohne Anmeldung) |
| `POST` | `/api/auth/setup` | ersten Admin anlegen – nur solange es keinen Benutzer gibt |
| `POST` | `/api/auth/login` | `{ username, password }` → Sitzungs-Cookie |
| `POST` | `/api/auth/logout` | Sitzung beenden → `204` |
| `POST` | `/api/auth/password` | eigenes Passwort ändern `{ currentPassword, newPassword }` |
| `GET` | `/api/users` | Benutzerliste (Admin: mit Rechten und Rezeptzahl) |
| `POST` | `/api/users` | Admin: Benutzer anlegen `{ username, password, isAdmin }` |
| `PATCH` | `/api/users/:id` | Admin: `{ password?, isAdmin? }` |
| `DELETE` | `/api/users/:id` | Admin: Benutzer löschen, Rezepte gehen an den Admin |
| `GET` | `/api/recipes/:id/shares` | Besitzer: Freigaben des Rezepts |
| `PUT` | `/api/recipes/:id/shares` | Besitzer: Freigaben ersetzen `[{ userId, canWrite }]` |
| `GET` | `/api/state` | Kühlschrank + Katalog in einem Aufruf (Startaufbau) |
| `GET` | `/api/recipes` | Rezeptübersicht: Suche, Sortierung, Paging |
| `GET` | `/api/recommendations` | Empfehlungen aus Kühlschrank + Suchfilter |
| `POST` | `/api/recipes` | Rezept anlegen → `201` + `Location` |
| `GET` | `/api/recipes/:id` | vollständiges Rezept inkl. Zutaten und Bild-URLs |
| `PUT` | `/api/recipes/:id` | Rezept vollständig ersetzen |
| `DELETE` | `/api/recipes/:id` | Rezept löschen (Zutaten + Bilder gehen mit) → `204` |
| `GET` | `/api/images/:id` | Bildbytes mit MIME-Typ |
| `GET` | `/api/fridge` | Kühlschrank auflisten |
| `POST` | `/api/fridge` | Eintrag anlegen → `201` |
| `PATCH` | `/api/fridge/:id` | Eintrag teilweise ändern |
| `DELETE` | `/api/fridge/:id` | Eintrag löschen → `204` |
| `DELETE` | `/api/fridge` | alles leeren → `{ "deleted": n }` |
| `GET` | `/api/catalog` | Zutaten-Vorschläge |
| `POST` | `/api/catalog` | Vorschlag ergänzen |
| `DELETE` | `/api/catalog/:name` | Vorschlag entfernen → `204` |
| `POST` | `/api/import` | Altbestand aus der localStorage-Version übernehmen |

### Rezeptübersicht: Suche, Sortierung, Paging

```
GET /api/recipes?search=zwiebel&sortBy=name&sortDir=asc&page=1&pageSize=20
```

Alle Parameter sind optional. Suche, Sortierung und Paging laufen direkt in
SQL — auch bei mehreren hundert Rezepten geht nur eine Seite an Daten über die
Leitung.

| Parameter | Werte | Standard |
|---|---|---|
| `search` | Freitext, geprüft gegen Name, Kurzbeschreibung und Zutatennamen | – (kein Filter) |
| `scope` | `all` (eigene + freigegebene), `mine`, `shared` | `all` |
| `sortBy` | `name`, `shortDesc`, `updatedAt`, `owner` | `name` |
| `sortDir` | `asc`, `desc` | `asc` |
| `page` | 1-basiert | `1` |
| `pageSize` | 1–100 | `20` |

Ein unbekannter `sortBy`-Wert fällt still auf `name` zurück; eine `page`
jenseits der letzten Seite wird auf die letzte gültige Seite begrenzt.

Antwort:

```json
{
  "items": [
    { "id": "mtx0bs0y...", "name": "Zwiebelkuchen", "shortDesc": "...",
      "updatedAt": "2026-09-11T13:43:51.203Z", "ingredientCount": 3, "imageCount": 1,
      "thumbnailUrl": "/api/images/mtx0dp13..." }
  ],
  "total": 102, "page": 1, "pageSize": 20, "totalPages": 6
}
```

### Empfehlungen

```
GET /api/recommendations?search=kartoffel&limit=5&exclude=id1,id2
```

Die Oberfläche ruft das erst per Klick auf „Neue Empfehlungen" auf. Alle
Parameter sind optional: `search` ist derselbe Filter wie in der Tabelle,
`limit` 1–10 (Standard 4), `exclude` sind die zuletzt gezeigten Rezept-IDs.

Ablauf des Algorithmus (`getRecommendations` in `db.js`):

1. **Kandidaten** sind alle Rezepte, die den Suchfilter erfüllen.
2. **Zutatenabgleich über das Kernwort:** bei „Rote Zwiebeln, gehackt" zählt
   „zwiebel" (Endungen wie -n/-en/-e werden gekürzt, Umlaute aufgelöst). Ein
   Kühlschrank-Eintrag trifft, wenn die Kernwörter gleich sind oder eines
   Anfang/Ende des anderen ist („Butter" ~ „Butterschmalz", „Kochspeck" ~
   „Speck"). Salz, Pfeffer, Wasser, Öl und Zucker gelten als immer da (halbes
   Gewicht).
3. **Dringlichkeit:** Kühlschrank-Einträge, die schon länger drin liegen,
   zählen bis zu 1,5-fach (Skala über 14 Tage) – Altes soll zuerst weg.
4. **Score** = 0,55 × Abdeckung + 0,45 × Verwertung − 0,03 × fehlende Zutaten.
5. **Gewichtete Zufallsziehung** (Gewicht = Score²) aus allen Rezepten mit
   mindestens einem Treffer: Gute Rezepte sind wahrscheinlicher, aber jeder
   Klick liefert eine andere Liste. Zuletzt gezeigte Rezepte (`exclude`)
   behalten nur 5 % Gewicht.
6. Reichen die Treffer nicht, wird aus dem Filter zufällig aufgefüllt
   (`reason: "filler"`); bei leerem Kühlschrank ist `basedOnFridge` `false`.

Antwort (gekürzt): `{ "items": [{ "id", "name", "shortDesc", "reason":
"fridge"|"filler", "matchCount", "totalIngredients", "matched": [...],
"missing": [...], "thumbnailUrl" }], "basedOnFridge", "fridgeItems",
"candidates", "search" }`.

### Rezept anlegen

```
POST /api/recipes
Content-Type: application/json
```

```json
{
  "name": "Zwiebelkuchen",
  "shortDesc": "Herbstklassiker mit Speck und Kümmel",
  "longText": "Hefeteig gehen lassen, Zwiebeln glasig dünsten ...",
  "category": "Vorspeise & Salat",
  "ingredients": [
    { "name": "Zwiebeln", "amount": "1 kg" },
    { "name": "Schmand",  "amount": "400 g" }
  ],
  "images": [
    { "name": "titel.png", "dataUrl": "data:image/png;base64,iVBORw0KG..." }
  ]
}
```

Antwort `201` mit dem gespeicherten Rezept. Pflichtfeld ist nur `name`.
Zutaten ohne Namen werden stillschweigend verworfen; die übrigen Namen wandern
automatisch in den Zutaten-Katalog.

`category` ist optional: leer (keine Kategorie) oder **genau ein** Wert aus der
festen Auswahlliste (`CATEGORY_OPTIONS` in `db.js`: Suppe, Vorspeise & Salat,
Fleisch, Fisch, Pasta & Italienisch, Asiatisch, Vegetarisch & Vegan, Beilage,
Brot & Backwaren, Dessert & Kuchen, Frühstück, Getränk). Ein anderer Wert
ergibt `400`. Der Client holt die Liste aus `GET /api/state`
(`categoryOptions`) und zeigt sie im Dialog als Auswahlfeld. Bestehende
Datenbanken bekommen die Spalte beim Start automatisch nachgezogen.

### Rezept ändern

```
PUT /api/recipes/:id
```

Gleicher Aufbau. Bestehende Bilder per `{ "id": "..." }` referenzieren, neue
per `{ "name": "...", "dataUrl": "..." }`. Zutaten werden komplett durch die
übergebene Liste ersetzt.

### Kühlschrank ändern

```
PATCH /api/fridge/:id
{ "amount": "125 g" }
```

Nur mitgeschickte Felder werden geändert. Ein leerer `name` wird abgelehnt.

### Feldgrenzen

| Feld | max. Länge |
|---|---|
| `name` (Rezept) | 80 |
| `shortDesc` | 150 |
| `longText` | 20000 |
| Zutat: `name` / `amount` | 60 / 30 |
| Kühlschrank: `name` / `amount` | 60 / 20 |

## Übernahme alter Browser-Daten

Die erste Fassung hielt alles im `localStorage`. Liegt dort noch etwas und ist
die Datenbank leer, bietet die App beim Laden einmalig die Übernahme an und
schickt den Bestand an `POST /api/import`. Datensätze mit bereits vergebener
`id` werden übersprungen, nicht überschrieben. Der Import lässt sich auch von
Hand aufrufen:

```bash
curl -X POST http://localhost:3000/api/import -H "Content-Type: application/json" -d @export.json
```

Im `localStorage` bleibt danach nur noch die Theme-Einstellung – eine
Anzeigeeinstellung pro Gerät, die auf dem Server nichts zu suchen hat.

## Sichern

Die Datenbank ist eine einzelne Datei. Server stoppen, `kochbuch.sqlite`
kopieren, fertig. Im laufenden Betrieb gehören die Dateien `kochbuch.sqlite-wal`
und `kochbuch.sqlite-shm` dazu; beim sauberen Beenden mit `Strg+C` schreibt der
Server das WAL zurück und räumt sie ab.

## Benutzer und Freigaben

- Ohne Anmeldung liefert die API nur `/api/health` und `/api/auth/*`, alles
  andere antwortet mit `401`. Die Seite selbst (HTML/CSS/JS) enthält keine Daten.
- **Ersteinrichtung:** Gibt es noch keinen Benutzer, zeigt die Seite statt der
  Anmeldung das Formular für den ersten Administrator. Rezepte ohne Besitzer
  (Bestand von vor Schema 2) gehen an diesen Admin.
- **Admins** legen Benutzer an, setzen Passwörter neu, vergeben/entziehen
  Adminrechte und löschen Benutzer. Die Rezepte eines gelöschten Benutzers gehen
  an den löschenden Admin über. Den letzten Admin und sich selbst kann man nicht
  herabstufen bzw. löschen.
- **Rezepte** gehören ihrem Ersteller. Der Besitzer kann sie pro Benutzer
  freigeben – *nur lesen* oder *lesen und bearbeiten*. Löschen und Freigaben
  ändern darf nur der Besitzer. Fremde Rezepte zeigen in der Liste, von wem sie
  stammen. Bilder liefert der Server nur an Benutzer, die das Rezept sehen dürfen.
- **Kühlschrank und Zutaten-Katalog** sind für alle Benutzer gemeinsam.
- **Sicherheit:** Passwörter als scrypt-Hash; Sitzungs-Cookie `HttpOnly`,
  `SameSite=Lax`, hinter HTTPS `Secure`, 30 Tage gültig und bei Nutzung
  verlängert. In der Datenbank liegt nur der SHA-256 des Tokens. Schreibende
  Anfragen mit fremdem `Origin` werden abgelehnt. Nach 10 Fehlversuchen je IP
  ist die Anmeldung 15 Minuten gesperrt. Ein neues Passwort beendet die übrigen
  Sitzungen des Benutzers.
