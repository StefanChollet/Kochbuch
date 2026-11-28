# Verteiler – chollet.corvent.ch

Startseite und Verteiler für alle Apps auf dem Webserver **trex**.
Ohne eigene Subdomains und ohne zusätzliche Ports: jede App bekommt einen
Unterpfad unter **https://chollet.corvent.ch/**.

```
https://chollet.corvent.ch/            → Container verteiler (nginx, statische Startseite)
https://chollet.corvent.ch/kochbuch/   → Container kochbuch:3000   (Ast master)
https://chollet.corvent.ch/travelfy/   → Container travelfy:3001   (Ast travelfy)
https://chollet.corvent.ch/<neu>/      → Container <neu>:<port>    (Ast <neu>)
```

## Aufbau auf trex (Docker)

```
/web/proxy/                     nginx-Container "proxy" (Ports 80/443, Zertifikate, Logs)
/web/proxy/conf.d/chollet.conf  Verteiler + alle Apps für chollet.corvent.ch (erzeugt)
/web/sites/<id>/app             Code der App – beim Einspielen ersetzt, alter Stand → app.bak-<zeit>
/web/sites/<id>/data            Daten (SQLite) – beim Einspielen nie angefasst, vorher gesichert
/web/sites/<id>/docker-compose.yml   Container node:22-alpine am Netz "web", ohne Host-Ports
/web/sites/verteiler/public     Startseite
```

Der Proxy erreicht jede App über ihren Container-Namen im Docker-Netz `web`.
Eine Quelle für alles: **`apps.json`**. Daraus erzeugt `node tools/build.js`
die Kacheln (`public/apps.json`), die Proxy-Datei (`deploy/proxy/chollet.conf`)
und je App eine `deploy/sites/<id>/docker-compose.yml`.

## Dateien

```
apps.json                  Apps: id, Name, Beschreibung, Port im Container, lokaler Ordner, Ast, Umgebung, Farbe, Icon
public/                    Startseite: index.html, verteiler.css, verteiler.js, icons/
tools/build.js             erzeugt public/apps.json + deploy/* aus apps.json
tools/lokal.js             lokaler Nachbau des Proxys zum Testen (Port 8080)
deploy/einspielen.sh       Einspielen auf trex per SSH (vom Entwicklungsrechner aus)
deploy/proxy/chollet.conf  (erzeugt)
deploy/sites/*/docker-compose.yml   (erzeugt)
```

## Regeln für jede App (Schema)

Damit Apps sich einen Host teilen können, ohne sich zu vermischen:

| Regel | Warum |
|---|---|
| Eigener Ordner `C:\develop\<App>`, eigener Ast `<id>` im Repo `StefanChollet/Kochbuch` | unabhängig entwickeln und einspielen |
| Unterpfad `/<id>` (`<ID>_BASE`), eigener Port im Container (`<ID>_PORT`); im Container auf `0.0.0.0` lauschen (`<ID>_HOST`), keine Host-Ports | erreichbar nur über den Proxy |
| Alle Adressen im Browser **relativ** (`api/...`, `seite.html`), Manifest `start_url`/`scope` = `./` | läuft unter jedem Unterpfad |
| Manifest `"id": "<id>"` – **nie** `"./"` | die `id` wird gegen die Wurzel des Hosts aufgelöst: `"./"` ergäbe für alle Apps dieselbe Kennung, und nach der ersten installierten App ließe sich keine weitere mehr installieren. (Ausnahme: Kochbuch behält `"./"`, damit bestehende Installationen gültig bleiben.) |
| Cookie `<id>_session` mit `Path=/<id>/` | keine App sieht die Anmeldung einer anderen |
| Service Worker mit Basis = eigenes Verzeichnis, Cache-Namen mit Präfix `<id>-`, nur eigene Caches löschen | Offline-Speicher bleiben getrennt |
| localStorage/sessionStorage-Schlüssel mit Präfix `<id>_` | keine Überschneidungen |
| Eigene SQLite-Datei unter `/data`, eigene Benutzer | Daten getrennt |
| **Sprung-Sperre** im Server: erlaubt sind nur Anfragen aus der eigenen App (Referer-Pfad `/<id>/…`), Seitenaufrufe von der Startseite (`/`) und direkte Aufrufe (`Sec-Fetch-Site: none`). Anfragen aus anderen Apps → 403 ohne Link | kein direkter Wechsel zwischen Apps |

Vorlage für Server und Browser-Teil: Travelfy (Ast `travelfy`, `server.js`, `public/common.js`).

## Neue App hinzufügen

1. App nach dem Schema oben bauen (nächster freier Port, z. B. 3002), committen.
2. Eintrag in `apps.json` (mit `ordner`, `ast`, `env`), Icon (192 px PNG) nach `public/icons/<id>.png`.
3. `node tools/build.js`, committen, Ast `verteiler` pushen.
4. Einspielen: `bash deploy/einspielen.sh <id>`, dann `verteiler` und `proxy`.

## Lokal testen

```powershell
cd C:\develop\Kochbuch;  node server.js        # Port 3000
cd C:\develop\Travelfy;  node server.js        # Port 3001
cd C:\develop\Verteiler; node tools/lokal.js   # http://localhost:8080/
```

## Einspielen auf trex

Vom Entwicklungsrechner aus (Git Bash, SSH-Schlüssel `~/.ssh/id_dinosaur`, Zugang `root@trex`):

```bash
bash deploy/einspielen.sh kochbuch     # eine App: Code aus dem lokalen Ast (nur Committetes)
bash deploy/einspielen.sh verteiler    # Startseite
bash deploy/einspielen.sh proxy        # chollet.conf, mit nginx -t und automatischem Zurückrollen
bash deploy/einspielen.sh alles
```

Pro App sichert das Skript vorher die Datenbank (`data/*.sqlite.bak-vor-update-<zeit>`,
per `VACUUM INTO` im laufenden Container) und den alten Code (`app.bak-<zeit>`).
Die `docker-compose.yml` einer App wird nur angelegt, wenn noch keine existiert.

Versionsnummer: Das Skript schreibt pro App `app/version.json`
(`{"version":"1.<Anzahl Commits im Ast>","commit":"<Kurz-Hash>","date":…,"deployedAt":…}`).
Die App zeigt sie unten links an und meldet, wenn eine offene Seite veraltet ist
(Regel für jede neue App: siehe README der Apps, Abschnitt „Versionsnummer“).

Alte Adressen: `https://chollet.corvent.ch/` zeigt die Startseite; geteilte
Kochansicht-Links `/kochansicht.html?code=…` leitet der Proxy auf
`/kochbuch/kochansicht.html?code=…` um. Die installierte Kochbuch-App (PWA)
muss einmal neu installiert werden.
