#!/usr/bin/env bash
# ==========================================================================
# Einspielen auf trex: Verteiler-Startseite + Travelfy (+ spaeter weitere Apps)
#
# Auf trex ausfuehren (als Benutzer mit sudo):
#     bash einspielen.sh            # alles
#     bash einspielen.sh verteiler  # nur Startseite + nginx-Ausschnitt
#     bash einspielen.sh travelfy   # nur eine App (holt/aktualisiert + Dienst)
#
# Das Kochbuch wird hier NICHT angefasst - es laeuft live und wird von Hand
# aktualisiert (Reihenfolge siehe README, Abschnitt "Einspielen").
# ==========================================================================
set -euo pipefail

# ---- Einstellungen (bei Bedarf anpassen) ---------------------------------
REPO="https://github.com/StefanChollet/Kochbuch.git"
APPS_ROOT="/opt"                      # jede App in /opt/<id>
APP_USER="${APP_USER:-$(id -un)}"     # Benutzer, unter dem die Apps laufen
WEB_ROOT="/var/www/verteiler"         # Startseite
SRC="$APPS_ROOT/verteiler"            # Checkout des Verteiler-Asts
SNIPPET="/etc/nginx/snippets/chollet-apps.conf"
# Apps, die dieses Skript verwaltet (id = Ast im Repo = Ordner = Unterpfad)
MANAGED_APPS=("travelfy")
# --------------------------------------------------------------------------

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mFEHLER: %s\033[0m\n' "$*" >&2; exit 1; }

check_node() {
  command -v node >/dev/null || fail "Node.js fehlt (benoetigt >= 22)."
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || fail "Node.js $(node -v) ist zu alt - benoetigt >= 22 (node:sqlite)."
}

# Holt einen Ast des Repos nach $1 bzw. aktualisiert ihn (nur fast-forward).
checkout() {
  local branch="$1" dir="$2"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --quiet origin "$branch"
    git -C "$dir" merge --ff-only --quiet "origin/$branch"
  else
    sudo mkdir -p "$dir"
    sudo chown "$APP_USER" "$dir"
    git clone --quiet --branch "$branch" --single-branch "$REPO" "$dir"
  fi
  echo "   $dir: $(git -C "$dir" log --oneline -1)"
}

deploy_verteiler() {
  say "Verteiler: Ast 'verteiler' nach $SRC"
  checkout verteiler "$SRC"

  say "Startseite nach $WEB_ROOT"
  sudo mkdir -p "$WEB_ROOT"
  sudo rsync -a --delete "$SRC/public/" "$WEB_ROOT/"

  say "nginx-Ausschnitt nach $SNIPPET"
  sudo mkdir -p "$(dirname "$SNIPPET")"
  sudo cp "$SRC/deploy/chollet-apps.conf" "$SNIPPET"

  if ! sudo grep -rqs "include snippets/chollet-apps.conf" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
    cat <<EOF

   *** Noch einmalig von Hand: ***
   In der nginx-Konfiguration von chollet.corvent.ch (server-Block mit
   "listen 443") das bisherige   location / { proxy_pass ...:3000; ... }
   ersetzen durch:

       include snippets/chollet-apps.conf;

   Vorlage: $SRC/deploy/chollet.corvent.ch.conf
   Danach:  sudo nginx -t && sudo systemctl reload nginx
EOF
    return
  fi
  say "nginx pruefen und neu laden"
  sudo nginx -t
  sudo systemctl reload nginx
}

deploy_app() {
  local id="$1" dir="$APPS_ROOT/$1"
  say "$id: Ast '$id' nach $dir"
  checkout "$id" "$dir"

  say "$id: systemd-Dienst"
  sed -e "s|@APP_USER@|$APP_USER|g" -e "s|@APPS_ROOT@|$APPS_ROOT|g" \
    "$SRC/deploy/$id.service" | sudo tee "/etc/systemd/system/$id.service" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet "$id"
  sudo systemctl restart "$id"
  sleep 2
  if ! systemctl is-active --quiet "$id"; then
    sudo journalctl -u "$id" -n 30 --no-pager
    fail "$id startet nicht (Log oben)."
  fi
  # Beim allerersten Start steht das Admin-Startpasswort im Log.
  sudo journalctl -u "$id" -n 15 --no-pager | grep -E "laeuft auf|Startpasswort" || true
}

# --------------------------------------------------------------------------
check_node
command -v rsync >/dev/null || fail "rsync fehlt (sudo apt install rsync)."
target="${1:-alles}"

# Der Verteiler-Checkout liefert die Dienst-Vorlagen - immer zuerst holen.
if [ "$target" = "alles" ] || [ "$target" = "verteiler" ]; then
  deploy_verteiler
else
  checkout verteiler "$SRC" >/dev/null
fi

for id in "${MANAGED_APPS[@]}"; do
  if [ "$target" = "alles" ] || [ "$target" = "$id" ]; then deploy_app "$id"; fi
done

say "Fertig. Test:  curl -sI https://chollet.corvent.ch/  und  .../travelfy/"
