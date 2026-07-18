import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase Browser Client
// ---------------------------------------------------------------------------
// Creates a singleton Supabase client for use in browser-side components.
//
// NEXT_PUBLIC_SUPABASE_URL: Your Supabase project URL (e.g., https://abc.supabase.co)
// NEXT_PUBLIC_SUPABASE_ANON_KEY: The public "anon" key (safe to expose in browser)
//
// The anon key is NOT a secret — it's a public key that identifies your project.
// Row-level security (RLS) policies in Supabase control what this key can access.
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
