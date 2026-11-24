"use strict";

/*
  Erzeugt aus apps.json (eine Quelle fuer alles) die Dateien fuer trex:

    public/apps.json                       Kacheln der Startseite (ohne interne Angaben)
    deploy/proxy/chollet.conf              nginx im Container "proxy" -> /web/proxy/conf.d/
    deploy/sites/<id>/docker-compose.yml   je App ein Container am Netz "web" -> /web/sites/<id>/
    deploy/sites/verteiler/docker-compose.yml   Startseite (nginx, statisch)

  Aufbau auf trex (Docker):
    /web/proxy/            nginx-Container "proxy", Ports 80/443, je Dienst eine conf.d/*.conf
    /web/sites/<id>/app    Code der App (wird beim Einspielen ersetzt, vorher app.bak-<zeit>)
    /web/sites/<id>/data   Daten (SQLite) - wird beim Einspielen nie angefasst
    Der Proxy erreicht jede App ueber ihren Container-Namen: <id>:<port>.

  Aufruf: node tools/build.js
*/

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "apps.json"), "utf8"));

/* ---- Pruefen ---- */
const seenIds = new Set();
for (const app of config.apps) {
  if (!/^[a-z0-9-]+$/.test(app.id)) throw new Error(`Ungueltige id "${app.id}" (nur a-z, 0-9, -)`);
  if (!Number.isInteger(app.port) || app.port < 1024 || app.port > 65535) throw new Error(`Ungueltiger Port bei ${app.id}`);
  if (seenIds.has(app.id)) throw new Error(`id doppelt: ${app.id}`);
  if (["icons", "apps.json", "index.html", "verteiler", "proxy"].includes(app.id)) throw new Error(`id "${app.id}" ist reserviert`);
  seenIds.add(app.id);
}

const write = (rel, content) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return rel;
};
const written = [];

/* ---- public/apps.json ---- */
written.push(write("public/apps.json", JSON.stringify({
  titel: config.titel,
  apps: config.apps.map(({ id, name, beschreibung, farbe, icon }) => ({ id, name, beschreibung, farbe, icon })),
}, null, 2) + "\n"));

/* ---- nginx (Container "proxy") ---- */
const PROXY_HEADERS = `
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_buffering off;
        proxy_read_timeout 300s;`;

const VERTEILER_HEADERS = `
        add_header Content-Security-Policy "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "same-origin" always;
        add_header X-Content-Type-Options "nosniff" always;`;

const appBlocks = config.apps.map((app) => `
    # --- ${app.name}: https://${config.host}/${app.id}/  ->  Container ${app.id}:${app.port}
    location = /${app.id} { return 301 /${app.id}/; }
    location /${app.id}/ {
        # Variable + Docker-Resolver: laeuft der Container gerade nicht,
        # scheitert nur diese Anfrage (502), nicht der ganze Proxy.
        set $upstream_${app.id.replace(/-/g, "_")} ${app.id}:${app.port};
        proxy_pass http://$upstream_${app.id.replace(/-/g, "_")};${PROXY_HEADERS}
    }`).join("\n");

written.push(write("deploy/proxy/chollet.conf", `# ==========================================================================
# ${config.host} - Verteiler und alle Apps.
# ERZEUGT von tools/build.js aus apps.json (Ast "verteiler") - nicht von Hand
# aendern: apps.json anpassen, "node tools/build.js", einspielen.
# Liegt auf trex in /web/proxy/conf.d/chollet.conf (Container "proxy").
# ==========================================================================

server {
    listen      80;
    server_name ${config.host};

    access_log  /var/log/nginx/chollet.access.log main;
    error_log   /var/log/nginx/chollet.error.log;

    # Muss vor der Umleitung stehen, damit Let's Encrypt (auch bei der
    # Erneuerung) immer per HTTP-01 antworten kann.
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen      443 ssl;
    http2       on;
    server_name ${config.host};

    ssl_certificate     /etc/nginx/certs/live/${config.host}/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/live/${config.host}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log  /var/log/nginx/chollet.access.log main;
    error_log   /var/log/nginx/chollet.error.log;

    # --- Verteiler-Startseite (Container "verteiler", statisch)
    location = / {
        set $upstream_verteiler verteiler:80;
        proxy_pass http://$upstream_verteiler;${PROXY_HEADERS}${VERTEILER_HEADERS}
    }
    location ~ ^/(index\\.html|verteiler\\.(css|js)|apps\\.json|favicon\\.svg|icons/[a-z0-9-]+\\.png)$ {
        set $upstream_verteiler verteiler:80;
        proxy_pass http://$upstream_verteiler;${PROXY_HEADERS}${VERTEILER_HEADERS}
    }

    # --- Alte Kochbuch-Adressen von vor dem Umzug unter /kochbuch/
    location = /kochansicht.html { return 302 /kochbuch/kochansicht.html$is_args$args; }
${appBlocks}

    # --- Alles andere gibt es nicht
    location / { return 404; }
}
`));

/* ---- docker-compose je App ---- */
for (const app of config.apps) {
  const env = Object.entries(app.env || {}).map(([k, v]) => `      ${k}: "${v}"`).join("\n");
  written.push(write(`deploy/sites/${app.id}/docker-compose.yml`, `# ${app.name} - https://${config.host}/${app.id}/
# ERZEUGT von tools/build.js aus apps.json (Ast "verteiler").
#
# KEINE ports: - der Dienst haengt nur am Netz "web" und wird ausschliesslich
# ueber den Proxy erreicht (/web/proxy/conf.d/chollet.conf).
# Code (./app) und Daten (./data) sind getrennt gemountet: ein Code-Update
# fasst die SQLite-Datenbank nicht an.
services:
  ${app.id}:
    image: node:22-alpine
    container_name: ${app.id}
    restart: unless-stopped
    working_dir: /app
    environment:
${env}
    volumes:
      - ./app:/app
      - ./data:/data
    command: node server.js
    networks:
      - web

networks:
  web:
    external: true
`));
}

/* ---- Verteiler-Container ---- */
written.push(write("deploy/sites/verteiler/docker-compose.yml", `# Verteiler-Startseite - https://${config.host}/
# ERZEUGT von tools/build.js. Statische Dateien aus ./public, ausgeliefert
# von nginx im eigenen Container (der Proxy leitet "/" hierher).
services:
  verteiler:
    image: nginx:1.29-alpine
    container_name: verteiler
    restart: unless-stopped
    volumes:
      - ./public:/usr/share/nginx/html:ro
    networks:
      - web

networks:
  web:
    external: true
`));

console.log("Erzeugt:\n  " + written.join("\n  "));
