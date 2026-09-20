# 🚀 Deploying the Scholarship App to Hostinger (VPS)

**Architecture deployed:**
- **Frontend** — React (Vite) static build served by **Nginx**
- **Backend** — Node.js + Express, kept alive by **PM2**, proxied by Nginx
- **Database** — **PostgreSQL** on the VPS

> ⚠️ Why a VPS and not shared Hostinger hosting: the backend uses **PostgreSQL**.
> Hostinger's shared hosting only provides MySQL. The VPS lets you run PostgreSQL
> alongside Node.js, which is why this guide targets a VPS. (A shared-hosting variant
> is noted at the end for completeness, but it's not recommendable for this stack.)

---

## 0. What you'll produce

| File | Purpose |
|------|---------|
| `deployment/ecosystem.config.js` | PM2 process config (API on `:3000`) |
| `deployment/nginx.conf` | Nginx site template (SPA + `/api` + `/uploads`) |
| `deployment/.env.production.example` | Production environment template |
| `deployment/setup.sh` | One-shot provisioning script (runs steps 4→9) |
| this file | Full manual walkthrough |

---

## 1. Build the frontend locally (Windows)

The backend has no build step. Only the React client needs building:

```powershell
cd "D:\Scholarship Application system\scholarship\client"
npm install
npm run build        # creates dist/
```

Because the client calls `/api` (relative) when `VITE_API_URL` is unset, you do
**not** need to set it — Nginx proxies `/api` to the backend on the same origin.

## 2. Provision a Hostinger VPS + DNS

1. In Hostinger hPanel: **VPS → Order VPS** (Ubuntu 22.04/24.04, 2 vCPU/4 GB is plenty to start).
2. Set your domain's **A record** to the VPS IP.
3. SSH in from a terminal:
   ```bash
   ssh root@YOUR_VPS_IP
   ```

## 3. Upload the code

From your machine, copy:
- `server/`  → `/var/www/scholarship/server`  (drop local test files like `uploads/*`, `_*.js`, logs)
- `scholarship/client/dist` → `/var/www/scholarship/client`
- `scholarship/database/migrations` → `/var/www/scholarship/scholarship/database/migrations`
- `deployment/` → `/var/www/scholarship/deployment`

Using `scp`:
```bash
scp -r "D:\Scholarship Application system\server" root@YOUR_VPS_IP:/var/www/scholarship/server
scp -r "D:\Scholarship Application system\scholarship\client\dist" root@YOUR_VPS_IP:/var/www/scholarship/client
```

## 4. Run the automated setup (recommended)

```bash
cd /var/www/scholarship/deployment
chmod +x setup.sh
sudo \
  DOMAIN=amora.bscs4a.com \
  DB_PASS='a_strong_db_password' \
  ADMIN_EMAIL=adminone@university.edu \
  ADMIN_PASS='a_strong_admin_password' \
  ./setup.sh
```

`setup.sh` performs: system update → Node 20 + Nginx + PostgreSQL + PM2 →
create DB/user → write `server/.env` → `npm install` → apply `supabase_schema.sql`
+ `009` + `010` → `node scripts/migrate-pg.js` → bootstrap the first admin →
install Nginx config → start the API under PM2.

After it finishes:
- Try the API: `curl http://127.0.0.1:3000/api/home`
- Add HTTPS: `sudo certbot --nginx -d amora.bscs4a.com`
- Watch logs: `pm2 logs scholarship-api`

## 5. Manual steps (if you don't use the script)

Equivalent of the above, done by hand:

```bash
# Install stack
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx postgresql postgresql-contrib
sudo npm install -g pm2

# Create DB + user
sudo -u postgres psql
  CREATE DATABASE scholarship_db;
  CREATE USER scholarship_user WITH PASSWORD 'a_strong_password';
  GRANT ALL PRIVILEGES ON DATABASE scholarship_db TO scholarship_user;
  \q

# .env
cd /var/www/scholarship/server
cp /var/www/scholarship/deployment/.env.production.example .env
# edit values (DB url, JWT_SECRET, CLIENT_URL/CLIENT_HOST)
npm install --omit=dev

# Schema + migrations
export PGPASSWORD='a_strong_password'
psql -h localhost -U scholarship_user -d scholarship_db -f /var/www/scholarship/scholarship/database/migrations/supabase_schema.sql
psql -h localhost -U scholarship_user -d scholarship_db -f /var/www/scholarship/scholarship/database/migrations/009_add_committee_fields.sql
psql -h localhost -U scholarship_user -d scholarship_db -f /var/www/scholarship/scholarship/database/migrations/010_seed_reference_data.sql
node scripts/migrate-pg.js

# First admin (public registration is staff-only, so admin is bootstrapped)
node bootstrap-admin.js --email adminone@university.edu --password 'a_strong_admin_password'

# Nginx
sudo cp /var/www/scholarship/deployment/nginx.conf /etc/nginx/sites-available/scholarship
sudo sed -i 's/YOURDOMAIN/amora.bscs4a.com/g' /etc/nginx/sites-available/scholarship
sudo ln -s /etc/nginx/sites-available/scholarship /etc/nginx/sites-enabled/scholarship
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# PM2
mkdir -p /var/www/scholarship/logs
cp /var/www/scholarship/deployment/ecosystem.config.js /var/www/scholarship/deployment/_ecosystem.generated.js
sed -i 's|/var/www/scholarship|/var/www/scholarship|g' /var/www/scholarship/deployment/_ecosystem.generated.js
pm2 start /var/www/scholarship/deployment/_ecosystem.generated.js
pm2 save && pm2 startup systemd
```

## 6. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d amora.bscs4a.com
```

## 7. Verify everything

- `curl https://amora.bscs4a.com/api/home` → JSON response
- Open `https://amora.bscs4a.com` → the SPA loads; deep links (e.g. `/login`, `/setup-account`) work via the Nginx SPA fallback
- Log in with the bootstrap admin at `/login`
- Upload a test document → confirm it appears (stored under `server/uploads/`, served at `/uploads/...`)

## 8. On-going care

- **Backups**: `pg_dump` the database + back up `server/uploads/` regularly.
  ```bash
  pg_dump -U scholarship_user -h localhost scholarship_db > backup.sql
  ```
- **Updates**: `pm2 restart scholarship-api` after pulling new backend code;
  rebuild the client (`npm run build`) and re-copy `dist/` for frontend changes.
- **Scale later**: move PostgreSQL to a managed service (set `DATABASE_URL`) and/or
  add more PM2 instances when you outgrow one VPS.

## 9. Shared-hosting alternative (not recommended)

Hostinger **shared** hosting gives you MySQL only and a limited Node.js runtime, so:
- You'd run PostgreSQL on an external managed service (Supabase/Neon/Aiven) and point `DATABASE_URL` at it.
- You'd run the Express backend through hPanel's Node.js section and upload `client/dist` to `public_html`.
- Expect friction: background sweeps, `uploads/` persistence, and long-lived processes are awkward on shared hosting.

For anything beyond a demo, use the **VPS** path above.

