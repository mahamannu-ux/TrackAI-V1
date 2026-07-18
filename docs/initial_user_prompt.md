You are an expert full-stack cloud architect. I am building a boilerplate MVP to test end-to-end wiring. The architecture must be completely decoupled to allow for future self-hosted VPC deployments.

Please generate a monorepo ( preferrably) or two separate project folders with the following specifications:

1. FRONTEND: Next.js (App Router, Tailwind CSS, TypeScript)
- Install `@supabase/supabase-js` and `@supabase/auth-ui-react` / `@supabase/auth-ui-shared`.
- Create a public `/login` page displaying the Supabase Auth UI component configured for standard email/password AND an enterprise SAML button.
- Create a protected `/dashboard` page that checks for an active session. If active, display:
  - A "View Items" button that fetches data from the Cloud Run Backend API.
  - A "Create Item" button that sends a POST request with dummy data to the Cloud Run Backend API.
- CRITICAL: All API requests to the backend must include the Supabase Access Token (JWT) in the `Authorization: Bearer <token>` header. The frontend must NEVER query the database directly.

2. BACKEND: Node.js (TypeScript, Express) with Docker & Drizzle ORM
- Include a `Dockerfile` optimized for Google Cloud Run (multi-stage build, exposing port 8080).
- Set up Drizzle ORM to connect to a PostgreSQL database using a `DATABASE_URL` environment variable. 
- Create a single database table schema named `items` (id: uuid, name: text, created_at: timestamp).
- Implement an authentication middleware that extracts the JWT from the Authorization header and verifies it using standard jsonwebtoken verification libraries against the Supabase JWT secret (`SUPABASE_JWT_SECRET`).
- Create two API routes protected by this middleware:
  - GET `/api/items`: Queries the `items` table via Drizzle and returns the list.
  - POST `/api/items`: Inserts a dummy item into the `items` table via Drizzle.

Provide the complete directory structure, configuration files (package.json, tsconfig, drizzle.config.ts), and the core source files with inline comments explaining how the JWT validation works.

"Ensure the backend template includes the standard CORS middleware configuration (e.g., using the cors package in Node.js or equivalent in your chosen language) to allow secure cross-origin requests from the local frontend URL."
you can create a environment_config.md, and a lightweight master_plan.md. skip coding_standards, guardrails, database_schema for now. you can create a checkpoint.md where you record what you have done, in case your quota gets exceeded.