# 🚀 Path A — Free deployment: Supabase + Render + Hostinger (frontend)

**Zero extra subscription.** You keep your Hostinger shared plan (for the domain + static frontend),
and the backend + database run on free tiers.

| Piece | Where | Cost |
|-------|-------|------|
| **Frontend** (React `dist/`) | Hostinger `public_html/` | already paid |
| **Domain** | `amora.bscs4a.com` | already paid |
| **Backend** (Node + Express) | **Render** (free tier) | $0 |
| **Database** (PostgreSQL) | **Supabase** | $0 |

Your Supabase connection string:
```
postgresql://postgres:scholarshipapp0102@db.ktcuvspjghaumrxkzufq.supabase.co:5432/postgres
```
*(The backend enables TLS for non-local hosts automatically, so this works as-is.)*

---

## Step 1 — Load the schema into Supabase (run on your PC)

Open PowerShell, then:
```powershell
cd "D:\Scholarship Application system\server"
$env:DATABASE_URL="postgresql://postgres:scholarshipapp0102@db.ktcuvspjghaumrxkzufq.supabase.co:5432/postgres"

node scripts/apply-base-schema.js     # base schema + committee fields + reference seeds
node scripts/migrate-pg.js            # slot-model / review-scoring migrations
```

## Step 2 — Create your admin account (straight into Supabase)

```powershell
cd "D:\Scholarship Application system\server"
node bootstrap-admin.js --email adminone@university.edu --password 'Your_Admin_Password'
```
(Keep the `$env:DATABASE_URL` from Step 1 set — delete it afterward with `Remove-Item Env:DATABASE_URL`.)

## Step 3 — Deploy the backend to Render

**Option A — Blueprint (automated):**
1. Create a **GitHub repo** and push/upload this project (at minimum `server/` and `deployment/render.yaml` at the repo root; keep the folder layout so `server/` is a top-level folder).
2. Go to **render.com → New → Blueprint** and connect the repo.
3. Render builds from `deployment/render.yaml`, creating the web service.
4. In the service's **Environment** tab set the two secrets Render didn't put in the file:
   - `DATABASE_URL = postgresql://postgres:scholarshipapp0102@db.ktcuvspjghaumrxkzufq.supabase.co:5432/postgres`
   - `JWT_SECRET = <long random string>`
5. **Deploy**, then copy the URL Render gives you, e.g. `https://scholarship-api.onrender.com`.

**Option B — Dashboard (manual):**
1. Push `server/` to a GitHub repo.
2. **Render → New → Web Service** → connect the repo.
3. Set: **Root Directory** `server` &middot; **Build** `npm install` &middot; **Start** `node src/server.js`.
4. Confirm the instance type is **Free**.
5. Add the same env vars as above, then **Deploy** and note the URL.

> ⚠️ Render free sleeps after ~15 min idle (cold start ~30–60s) and its disk is **ephemeral** —
> uploaded documents in `uploads/` persist only for the life of the instance. Database data is safe (Supabase).

## Step 4 — Build the frontend for cross-origin

Because the frontend (Hostinger) and backend (Render) are on different origins,
bake the API URL into the build:
```powershell
cd "D:\Scholarship Application system\scholarship\client"
# create a file named  .env.production  containing:
#   VITE_API_URL=https://scholarship-api.onrender.com/api
npm run build
```

## Step 5 — Upload the frontend to Hostinger

1. hPanel → **Websites** → **File Manager** → open `public_html/` (or your subdomain's document root).
2. Upload the **contents** of `scholarship\client\dist` (`index.html`, `assets/`, etc.) into it.
3. Wait for DNS to propagate, then open `https://amora.bscs4a.com`.

## Step 6 — Verify

- `https://amora.bscs4a.com` loads the React app.
- Log in with `adminone@university.edu`.
- Upload a test document — remember it stores on Render's ephemeral disk (fine for a demo).
- If the page loads but API calls fail, check `amora.bscs4a.com`'s **DNS actually points at Hostinger**, and that `VITE_API_URL` = your exact Render URL (rebuild + re-upload if you changed it).