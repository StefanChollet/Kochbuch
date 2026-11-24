"use strict";

/*
  Erzeugt aus apps.json (eine Quelle fuer alles):
    public/apps.json          - Kacheln der Startseite (ohne interne Ports)
    deploy/chollet-apps.conf  - nginx-Ausschnitt: Startseite + je App ein Block
    deploy/<id>.service       - systemd-Unit je App (Vorlage, Platzhalter @APP_USER@ / @APPS_ROOT@)

  Aufruf: node tools/build.js
  Danach committen und auf trex mit deploy/einspielen.sh einspielen.
*/

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "apps.json"), "utf8"));

/* ---- Pruefen ---- */
const seenIds = new Set();
const seenPorts = new Set();
for (const app of config.apps) {
  if (!/^[a-z0-9-]+$/.test(app.id)) throw new Error(`Ungueltige id "${app.id}" (nur a-z, 0-9, -)`);
  if (!Number.isInteger(app.port) || app.port < 1024 || app.port > 65535) throw new Error(`Ungueltiger Port bei ${app.id}`);
  if (seenIds.has(app.id)) throw new Error(`id doppelt: ${app.id}`);
  if (seenPorts.has(app.port)) throw new Error(`Port doppelt: ${app.port}`);
  if (["icons", "apps.json", "index.html"].includes(app.id)) throw new Error(`id "${app.id}" ist reserviert`);
  seenIds.add(app.id);
  seenPorts.add(app.port);
}

/* ---- public/apps.json ---- */
const publicConfig = {
  titel: config.titel,
  apps: config.apps.map(({ id, name, beschreibung, farbe, icon }) => ({ id, name, beschreibung, farbe, icon })),
};
fs.writeFileSync(path.join(ROOT, "public", "apps.json"), JSON.stringify(publicConfig, null, 2) + "\n");

/* ---- nginx ---- */
const VERTEILER_HEADERS = `
        add_header Content-Security-Policy "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "same-origin" always;
        add_header X-Content-Type-Options "nosniff" always;`;

const appBlocks = config.apps.map((app) => `
    # --- ${app.name}: https://${config.host}/${app.id}/  ->  127.0.0.1:${app.port}
    location = /${app.id} { return 301 /${app.id}/; }
    location /${app.id}/ {
        proxy_pass http://127.0.0.1:${app.port};
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 32m;
    }`).join("\n");

const nginx = `# ==========================================================================
# Verteiler fuer https://${config.host}/  -  ERZEUGT von tools/build.js aus
# apps.json. Nicht von Hand aendern: apps.json anpassen, neu erzeugen.
#
# Gehoert INNERHALB des server { ... }-Blocks von ${config.host}
# (Port 443) und ersetzt dort das bisherige "location / { ... }":
#     include snippets/chollet-apps.conf;
# ==========================================================================

    # --- Verteiler-Startseite (statisch)
    root /var/www/verteiler;

    location = / {
        try_files /index.html =404;${VERTEILER_HEADERS}
    }
    location ~ ^/(index\\.html|verteiler\\.(css|js)|apps\\.json|favicon\\.svg|icons/[a-z0-9-]+\\.png)$ {
        try_files $uri =404;${VERTEILER_HEADERS}
    }

    # --- Alte Kochbuch-Adressen von vor dem Umzug unter /kochbuch/
    location = /kochansicht.html { return 302 /kochbuch/kochansicht.html$is_args$args; }
${appBlocks}

    # --- Alles andere gibt es nicht
    location / { return 404; }
`;
fs.writeFileSync(path.join(ROOT, "deploy", "chollet-apps.conf"), nginx);

/* ---- systemd ---- */
for (const app of config.apps) {
  const env = app.id.toUpperCase().replace(/-/g, "_");
  const unit = `# Erzeugt von tools/build.js - ${app.name} auf trex
[Unit]
Description=${app.name} (https://${config.host}/${app.id}/)
After=network.target

[Service]
Type=simple
User=@APP_USER@
WorkingDirectory=@APPS_ROOT@/${app.id}
ExecStart=/usr/bin/env node server.js
Environment=NODE_ENV=production
Environment=PORT=${app.port}
Environment=${env}_PORT=${app.port}
Environment=${env}_HOST=127.0.0.1
Environment=${env}_BASE=/${app.id}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(path.join(ROOT, "deploy", `${app.id}.service`), unit);
}

console.log(`Erzeugt: public/apps.json, deploy/chollet-apps.conf, ${config.apps.map((a) => `deploy/${a.id}.service`).join(", ")}`);
