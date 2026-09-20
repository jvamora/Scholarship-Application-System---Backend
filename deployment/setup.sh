#!/usr/bin/env bash
# ============================================================
# One-shot provisioning for the Scholarship app on a fresh
# Hostinger VPS (Ubuntu 22.04 / 24.04).
#
# PREREQUISITE: upload your code first so this script can find it:
#   server/     -> $APP_DIR/server          (the Node backend)
#   client/dist -> $APP_DIR/client          (the built React SPA)
#   deployment/ -> $APP_DIR/deployment      (these files)
#
# Then run (from $APP_DIR/deployment):
#   chmod +x setup.sh
#   sudo DOMAIN=amora.bscs4a.com DB_PASS='<dbpass>' \
#        ADMIN_EMAIL=adminone@university.edu ADMIN_PASS='<adminpass>' ./setup.sh
#
# Everything it does is idempotent-ish; re-running mostly skips work.
# ============================================================
set -euo pipefail

# ---------- CONFIG (override via environment) ----------
APP_DIR="${APP_DIR:-/var/www/scholarship}"
SERVER_DIR="$APP_DIR/server"
CLIENT_DIR="$APP_DIR/client"
DEPLOY_DIR="$APP_DIR/deployment"
LOGS_DIR="$APP_DIR/logs"
DOMAIN="${DOMAIN:-amora.bscs4a.com}"
APP_PORT="${APP_PORT:-3000}"
DB_NAME="${DB_NAME:-scholarship_db}"
DB_USER="${DB_USER:-scholarship_user}"
DB_PASS="${DB_PASS:-CHANGE_ME_DB_PASSWORD}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-adminone@university.edu}"
ADMIN_PASS="${ADMIN_PASS:-CHANGE_ME_ADMIN_PASSWORD}"
SMTP_ENABLED="${SMTP_ENABLED:-no}"   # 'yes' if you have SMTP creds to use

[ "$DB_PASS" = "CHANGE_ME_DB_PASSWORD" ] && \
  { echo "ERROR: set DB_PASS"; exit 1; }
[ "$ADMIN_PASS" = "CHANGE_ME_ADMIN_PASSWORD" ] && \
  { echo "ERROR: set ADMIN_PASS (min 8 chars)"; exit 1; }

echo "==> [1/9] System update + stack install"
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx postgresql postgresql-contrib
sudo npm install -g pm2

echo "==> [2/9] Create PostgreSQL database + user (idempotent)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
else
  echo "   database '$DB_NAME' already exists"
fi

echo "==> [3/9] Write server .env"
SCHEMA_SRC="$DEPLOY_DIR/.env.production.example"
ENV_DST="$SERVER_DIR/.env"
if [ -f "$ENV_DST" ]; then
  echo "   .env already exists -> leaving it untouched"
else
  cp "$SCHEMA_SRC" "$ENV_DST"
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME|" "$ENV_DST"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" "$ENV_DST"
  sed -i "s|^CLIENT_URL=.*|CLIENT_URL=https://$DOMAIN|" "$ENV_DST"
  sed -i "s|^CLIENT_HOST=.*|CLIENT_HOST=$DOMAIN|" "$ENV_DST"
  echo "   wrote $ENV_DST (SMTP left as placeholders; fill in later if used)"
fi
# Load the env for the remaining steps in this script
set -a; [ -f "$ENV_DST" ] && . "$ENV_DST"; set +a

echo "==> [4/9] Install backend dependencies"
cd "$SERVER_DIR"
[ -d node_modules ] || npm install --omit=dev

echo "==> [5/9] Apply database schema + seed reference data"
export PGPASSWORD="$DB_PASS"
SCHEMA_DIR="$APP_DIR/scholarship/database/migrations"
if [ -d "$SCHEMA_DIR" ]; then
  psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f "$SCHEMA_DIR/supabase_schema.sql"
  psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f "$SCHEMA_DIR/009_add_committee_fields.sql"
  psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f "$SCHEMA_DIR/010_seed_reference_data.sql"
else
  echo "   WARN: schema folder not found at $SCHEMA_DIR"
  echo "   Upload the repo (or at least scholarship/database/migrations) and re-run."
fi

echo "==> [6/9] Run Postgres migration runner (slot-model v2, review scoring)"
cd "$SERVER_DIR"
node scripts/migrate-pg.js

echo "==> [7/9] Bootstrap the first admin account"
cd "$SERVER_DIR"
node bootstrap-admin.js --email "$ADMIN_EMAIL" --password "$ADMIN_PASS"

echo "==> [8/9] Nginx: install config + enable"
if [ -f "/etc/nginx/sites-available/scholarship" ] && ! grep -q "$DOMAIN" /etc/nginx/sites-available/scholarship 2>/dev/null; then
  echo "   nginx config exists; skipping overwrite (edit manually if needed)"
else
  sudo cp "$DEPLOY_DIR/nginx.conf" /etc/nginx/sites-available/scholarship
  sudo sed -i "s/YOURDOMAIN/$DOMAIN/g" /etc/nginx/sites-available/scholarship
fi
sudo ln -sf /etc/nginx/sites-available/scholarship /etc/nginx/sites-enabled/scholarship
# remove the default site so it doesn't shadow us
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> [9/9] PM2: start API on port $APP_PORT"
mkdir -p "$LOGS_DIR"
cd "$SERVER_DIR"
# point ecosystem at the right cwd/port on disk
sudo cp "$DEPLOY_DIR/ecosystem.config.js" "$DEPLOY_DIR/_ecosystem.generated.js"
sudo sed -i "s|/var/www/scholarship|$APP_DIR|g" "$DEPLOY_DIR/_ecosystem.generated.js"
sudo sed -i "s|PORT=3000|PORT=$APP_PORT|" "$ENV_DST" || true
sudo chown -R "$(whoami)" "$SERVER_DIR" "$LOGS_DIR"
pm2 start "$DEPLOY_DIR/_ecosystem.generated.js"
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || \
  echo "   run 'pm2 startup systemd' manually once"

echo ""
echo "=============================================================="
echo " DONE. Backend is up behind Nginx on http://$DOMAIN"
echo "   - Test API:  curl http://127.0.0.1:$APP_PORT/api/home"
echo "   - Add HTTPS: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo "   - Logs:      pm2 logs scholarship-api"
echo "   - Admin:     $ADMIN_EMAIL  (password set by you)"
echo " KEEP this admin credential safe."
echo "=============================================================="
