# Verteiler – chollet.corvent.ch

Startseite und nginx-Verteiler für alle Apps auf dem Webserver **trex**.
Ohne eigene Subdomains und ohne zusätzliche Ports: jede App bekommt einen
Unterpfad unter **https://chollet.corvent.ch/**.

```
https://chollet.corvent.ch/            → Startseite (Kacheln, statisch aus public/)
https://chollet.corvent.ch/kochbuch/   → 127.0.0.1:3000   (Ast master,   /opt bzw. bisheriger Ort)
https://chollet.corvent.ch/travelfy/   → 127.0.0.1:3001   (Ast travelfy, /opt/travelfy)
https://chollet.corvent.ch/<neu>/      → 127.0.0.1:3002 … (Ast <neu>,    /opt/<neu>)
```

Eine Quelle für alles: **`apps.json`**. Daraus erzeugt `node tools/build.js`
die Kacheln (`public/apps.json`), den nginx-Ausschnitt
(`deploy/chollet-apps.conf`) und je App eine systemd-Unit
(`deploy/<id>.service`).

## Aufbau

```
apps.json                  Liste der Apps (id, Name, Beschreibung, Port, Farbe, Icon)
public/                    Startseite: index.html, verteiler.css, verteiler.js, icons/
tools/build.js             erzeugt public/apps.json + deploy/* aus apps.json
tools/lokal.js             lokaler Nachbau von nginx zum Testen (Port 8080)
deploy/chollet-apps.conf   nginx-Ausschnitt (erzeugt)
deploy/<id>.service        systemd-Units (erzeugt, Platzhalter @APP_USER@/@APPS_ROOT@)
deploy/chollet.corvent.ch.conf   Vorlage der nginx-Site
deploy/einspielen.sh       Einspielen auf trex
```

## Regeln für jede App (Schema)

Damit Apps sich einen Host teilen können, ohne sich zu vermischen:

| Regel | Warum |
|---|---|
| Eigener Ordner `C:\develop\<App>`, eigener Ast `<id>` im Repo `StefanChollet/Kochbuch` | unabhängig entwickeln und einspielen |
| Unterpfad `/<id>` (Umgebungsvariable `<ID>_BASE`), Server lauscht auf `127.0.0.1` (`<ID>_HOST`), eigener Port (`<ID>_PORT`) | erreichbar nur über nginx |
| Alle Adressen im Browser **relativ** (`api/...`, `seite.html`), Manifest `start_url`/`scope` = `./` | läuft unter jedem Unterpfad |
| Cookie `<id>_session` mit `Path=/<id>/` | keine App sieht die Anmeldung einer anderen |
| Service Worker mit Basis = eigenes Verzeichnis, Cache-Namen mit Präfix `<id>-`, nur eigene Caches löschen | Offline-Speicher bleiben getrennt |
| localStorage/sessionStorage-Schlüssel mit Präfix `<id>_` | keine Überschneidungen |
| Eigene SQLite-Datei, eigene Benutzer | Daten getrennt |
| **Sprung-Sperre** im Server: erlaubt sind nur Anfragen aus der eigenen App (Referer-Pfad `/<id>/…`), Seitenaufrufe von der Startseite (`/`) und direkte Aufrufe (`Sec-Fetch-Site: none`). Anfragen aus anderen Apps → 403 ohne Link | kein direkter Wechsel zwischen Apps |

Vorlage für Server und Browser-Teil: Travelfy (Ast `travelfy`, `server.js`, `public/common.js`).

## Neue App hinzufügen

1. App nach dem Schema oben bauen (nächster freier Port, z. B. 3002).
2. Eintrag in `apps.json` ergänzen, Icon (192 px PNG) nach `public/icons/<id>.png`.
3. `node tools/build.js`, committen, Ast `verteiler` pushen.
4. In `deploy/einspielen.sh` die id in `MANAGED_APPS` ergänzen.
5. Auf trex: `bash /opt/verteiler/deploy/einspielen.sh`.

## Lokal testen

```powershell
cd C:\develop\Kochbuch;  node server.js        # Port 3000
cd C:\develop\Travelfy;  node server.js        # Port 3001
cd C:\develop\Verteiler; node tools/lokal.js   # http://localhost:8080/
```

## Einspielen auf trex

Reihenfolge beim ersten Mal (das Kochbuch läuft live):

1. **Kochbuch aktualisieren** (Stand mit Unterpfad `/kochbuch`) und neu starten.
   Das alte nginx leitet noch alles an Port 3000 – das Kochbuch leitet `/` selbst
   auf `/kochbuch/` um, es bleibt also erreichbar.
2. **Verteiler und Travelfy**:
   ```bash
   git clone --branch verteiler https://github.com/StefanChollet/Kochbuch.git /opt/verteiler   # nur beim ersten Mal
   bash /opt/verteiler/deploy/einspielen.sh
   ```
   Beim ersten Start von Travelfy steht das Admin-Startpasswort in der Ausgabe.
3. **nginx einmalig umstellen**: im 443-Block von `chollet.corvent.ch` das alte
   `location / { … }` durch `include snippets/chollet-apps.conf;` ersetzen
   (Vorlage `deploy/chollet.corvent.ch.conf`), dann
   `sudo nginx -t && sudo systemctl reload nginx`.

Danach genügt für Updates `bash /opt/verteiler/deploy/einspielen.sh`.

Alte Adressen: `https://chollet.corvent.ch/` zeigt jetzt die Startseite;
geteilte Kochansicht-Links `/kochansicht.html?code=…` leitet nginx auf
`/kochbuch/kochansicht.html?code=…` um. Die installierte Kochbuch-App (PWA)
muss einmal neu installiert werden.
