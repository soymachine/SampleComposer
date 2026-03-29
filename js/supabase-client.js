/**
 * supabase-client.js — Lazy-loaded Supabase client singleton.
 * Returns null if credentials are not configured yet.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_ENABLED } from './config.js';

let _client = null;

export async function getSupabase() {
  if (!SUPABASE_ENABLED) return null;
  if (_client) return _client;
  const { createClient } = await import(
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
  );
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

export { SUPABASE_ENABLED };
