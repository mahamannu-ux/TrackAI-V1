import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// ---------------------------------------------------------------------------
// Database Client
// ---------------------------------------------------------------------------
// Creates a PostgreSQL connection pool using the DATABASE_URL env var.
// This supports both local development and Cloud Run deployments.
//
// In Cloud Run, DATABASE_URL can be injected via:
//   - Environment variable (plain text or Secret Manager reference)
//   - Cloud SQL Auth Proxy (unix socket connection)
//
// For self-hosted VPC deployments, point DATABASE_URL at your PostgreSQL
// instance (e.g., a VM, managed service, or container).
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Export the Drizzle ORM instance with typed schema.
// All queries benefit from full TypeScript inference.
export const db = drizzle(pool, { schema });
