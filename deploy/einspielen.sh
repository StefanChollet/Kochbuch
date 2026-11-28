#!/usr/bin/env bash
# ==========================================================================
# Einspielen auf trex - laeuft auf dem Entwicklungsrechner (Git Bash) und
# arbeitet ueber SSH. Aufbau auf trex siehe tools/build.js / README.
#
#   bash deploy/einspielen.sh <app-id>    eine App (z.B. kochbuch, travelfy)
#   bash deploy/einspielen.sh verteiler   Startseite
#   bash deploy/einspielen.sh proxy       nginx-Konfiguration (chollet.conf)
#   bash deploy/einspielen.sh alles       Apps, Startseite, Proxy
#
# Je App: Code aus dem lokalen Git-Ast (apps.json: ordner/ast) - nur
# Committetes, nichts Ungespeichertes. Vorher auf trex: Sicherung des alten
# Codes (app.bak-<zeit>) und der Datenbank (*.sqlite.bak-vor-update-<zeit>).
# ==========================================================================
set -euo pipefail

TREX="${TREX:-root@trex}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_dinosaur}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mFEHLER: %s\033[0m\n' "$*" >&2; exit 1; }
remote() { ssh -i "$SSH_KEY" -o BatchMode=yes "$TREX" "$@"; }

# Feld aus apps.json lesen: app_field <id> <feld>
app_field() {
  node -e '
    const c = require(process.argv[1]);
    const a = c.apps.find((x) => x.id === process.argv[2]);
    if (!a) process.exit(2);
    process.stdout.write(String(a[process.argv[3]] ?? ""));
  ' "$ROOT/apps.json" "$1" "$2" || fail "App \"$1\" steht nicht in apps.json."
}
app_ids() { node -e 'process.stdout.write(require(process.argv[1]).apps.map((a) => a.id).join(" "))' "$ROOT/apps.json"; }

deploy_app() {
  local id="$1"
  local ordner ast dir="/web/sites/$1"
  ordner="$(app_field "$id" ordner)"
  ast="$(app_field "$id" ast)"
  [ -f "$ROOT/deploy/sites/$id/docker-compose.yml" ] || fail "deploy/sites/$id fehlt - zuerst: node tools/build.js"
  git -C "$ordner" rev-parse --verify --quiet "$ast" >/dev/null || fail "Ast $ast fehlt in $ordner."

  say "$id: $(git -C "$ordner" log --oneline -1 "$ast")  (Ast $ast)"

  # Datenbank konsistent sichern (VACUUM INTO im laufenden Container)
  remote "set -e; d=$dir
    if docker ps --format '{{.Names}}' | grep -qx '$id'; then
      for f in \$(cd \$d/data 2>/dev/null && ls *.sqlite 2>/dev/null); do
        # Dateiname per Umgebungsvariable, nicht im Code - kein Quoting-Salat.
        docker exec -e F=\"\$f\" -e T=$TS $id node --no-warnings -e '
          const f = process.env.F, ziel = \"/data/\" + f + \".bak-vor-update-\" + process.env.T;
          new (require(\"node:sqlite\").DatabaseSync)(\"/data/\" + f).exec(\"VACUUM INTO \x27\" + ziel + \"\x27\");'
        test -s \"\$d/data/\$f.bak-vor-update-$TS\" || { echo \"   Sicherung von \$f fehlgeschlagen\"; exit 1; }
        echo \"   Sicherung: \$d/data/\$f.bak-vor-update-$TS\"
      done
    fi"

  # Neuen Code daneben auspacken, dann tauschen (alter Code -> app.bak-<zeit>)
  git -C "$ordner" archive --format=tar "$ast" | remote "set -e; d=$dir
    mkdir -p \$d/data \$d/app.neu-$TS
    tar -x -C \$d/app.neu-$TS
    if [ -d \$d/app ]; then mv \$d/app \$d/app.bak-$TS; echo '   alter Code: '\$d/app.bak-$TS; fi
    mv \$d/app.neu-$TS \$d/app"

  # Versionsnummer aus Git: "1.<Anzahl Commits>" + Kurz-Hash + Commit-Datum.
  # Die App zeigt sie unten links an (server.js liest version.json).
  local v_count v_commit v_date
  v_count="$(git -C "$ordner" rev-list --count "$ast")"
  v_commit="$(git -C "$ordner" rev-parse --short "$ast")"
  v_date="$(git -C "$ordner" log -1 --format=%cI "$ast")"
  printf '{"version":"1.%s","commit":"%s","date":"%s","deployedAt":"%s"}\n' \
    "$v_count" "$v_commit" "$v_date" "$(date -Iseconds)" | remote "cat > $dir/app/version.json"
  echo "   Version: 1.$v_count ($v_commit)"

  # docker-compose.yml nur anlegen, wenn noch keine da ist
  if ! remote "test -f $dir/docker-compose.yml"; then
    remote "cat > $dir/docker-compose.yml" < "$ROOT/deploy/sites/$id/docker-compose.yml"
    echo "   docker-compose.yml angelegt"
  fi

  remote "set -e; cd $dir; docker compose up -d --quiet-pull; docker restart $id >/dev/null; sleep 3
    docker ps --filter name=^$id\$ --format '   Container: {{.Names}} {{.Status}}'
    docker logs --tail 8 $id 2>&1 | sed 's/^/   | /'"
}

deploy_verteiler() {
  local dir=/web/sites/verteiler
  say "verteiler: Startseite"
  tar -C "$ROOT/public" -cf - . | remote "set -e; d=$dir
    mkdir -p \$d/public.neu-$TS
    tar -x -C \$d/public.neu-$TS
    if [ -d \$d/public ]; then mv \$d/public \$d/public.bak-$TS; fi
    mv \$d/public.neu-$TS \$d/public"
  remote "cat > $dir/docker-compose.yml" < "$ROOT/deploy/sites/verteiler/docker-compose.yml"
  remote "set -e; cd $dir; docker compose up -d --quiet-pull
    docker ps --filter name=^verteiler\$ --format '   Container: {{.Names}} {{.Status}}'"
}

deploy_proxy() {
  say "proxy: /web/proxy/conf.d/chollet.conf"
  remote "cat > /web/proxy/chollet.conf.neu-$TS" < "$ROOT/deploy/proxy/chollet.conf"
  remote "set -e; c=/web/proxy/conf.d
    # Bisherige Dateien ausserhalb von conf.d sichern (nur *.conf wird gelesen)
    [ -f \$c/chollet.conf ]  && cp \$c/chollet.conf  /web/proxy/chollet.conf.bak-$TS
    [ -f \$c/kochbuch.conf ] && mv \$c/kochbuch.conf /web/proxy/kochbuch.conf.bak-$TS && echo '   altes kochbuch.conf -> /web/proxy/kochbuch.conf.bak-$TS'
    mv /web/proxy/chollet.conf.neu-$TS \$c/chollet.conf
    if docker exec proxy nginx -t 2>&1 | sed 's/^/   | /'; [ \${PIPESTATUS[0]} -eq 0 ]; then
      docker exec proxy nginx -s reload && echo '   nginx neu geladen'
    else
      echo '   nginx -t fehlgeschlagen - stelle den alten Stand wieder her'
      rm -f \$c/chollet.conf
      [ -f /web/proxy/chollet.conf.bak-$TS ]  && cp /web/proxy/chollet.conf.bak-$TS \$c/chollet.conf
      [ -f /web/proxy/kochbuch.conf.bak-$TS ] && mv /web/proxy/kochbuch.conf.bak-$TS \$c/kochbuch.conf
      exit 1
    fi"
}

# --------------------------------------------------------------------------
command -v node >/dev/null || fail "node fehlt auf diesem Rechner."
node "$ROOT/tools/build.js" >/dev/null
target="${1:-}"
case "$target" in
  alles)
    for id in $(app_ids); do deploy_app "$id"; done
    deploy_verteiler
    deploy_proxy ;;
  verteiler) deploy_verteiler ;;
  proxy)     deploy_proxy ;;
  "")        fail "Was einspielen? <app-id> | verteiler | proxy | alles" ;;
  *)         deploy_app "$target" ;;
esac

say "Fertig."
