# TrackAI-v1 — Environment Configuration

All configuration is injected via environment variables. **Never commit secrets to git.**

---

## Frontend (`apps/web`)

Copy `.env.local.example` → `.env.local` and fill in values.

| Variable | Required | Public | Description | Example |
|----------|----------|--------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Yes | Supabase project URL | `https://abcdefgh.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Yes | Supabase public anon key (safe for browser) | `eyJhbGciOiJIUzI1NiIs...` |
| `NEXT_PUBLIC_API_URL` | ✅ | Yes | Backend API base URL | `http://localhost:8080` (dev) / `https://api-xyz.a.run.app` (prod) |

> [!NOTE]
> `NEXT_PUBLIC_` prefixed variables are embedded in the client bundle at build time. The anon key is intentionally public — Supabase RLS policies enforce access control.

---

## Backend (`apps/api`)

Copy `.env.example` → `.env` and fill in values.

| Variable              | Required | Secret | Description                             | Example                                         |
| -----------------------| ----------| --------| -----------------------------------------| -------------------------------------------------|
| `DATABASE_URL`        | ✅        | 🔒 Yes | PostgreSQL connection string            | `postgresql://user:pass@localhost:5432/trackai` |
| `SUPABASE_JWT_SECRET` | ✅        | 🔒 Yes | Supabase JWT signing secret (HS256)     | `your-super-secret-jwt-token-...`               |
| `FRONTEND_URL`        | ✅        | No　　 | Allowed CORS origin(s), comma-separated | `http://localhost:3000`                         |
| `PORT`                | ❌        | No　　 | Server port (defaults to `8080`)        | `8080`                                          |

> [!IMPORTANT]
> **Where to find `SUPABASE_JWT_SECRET`:**
> Supabase Dashboard → Settings → API → JWT Secret (under "JWT Settings")

---

## How to Get Your Values

### 1. Supabase Project Setup
1. Go to [app.supabase.com](https://app.supabase.com) → Create a new project
2. Navigate to **Settings → API**
3. Copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **JWT Secret** → `SUPABASE_JWT_SECRET`

### 2. Database URL
- **Supabase hosted**: Settings → Database → Connection string (URI format)
- **Self-hosted**: `postgresql://user:password@host:5432/dbname`

### 3. Cloud Run Deployment
When deploying to Cloud Run, inject secrets via:
```bash
gcloud run deploy trackai-api \
  --set-env-vars="FRONTEND_URL=https://your-app.vercel.app" \
  --set-secrets="DATABASE_URL=db-url:latest,SUPABASE_JWT_SECRET=jwt-secret:latest"
```

---

## CORS Configuration

The backend CORS middleware reads `FRONTEND_URL` to allow cross-origin requests.

| Environment | `FRONTEND_URL` Value |
|-------------|---------------------|
| Local dev | `http://localhost:3000` |
| Staging | `https://staging.your-app.com` |
| Production | `https://your-app.com` |
| Multiple origins | `https://app.com,https://staging.app.com` |
