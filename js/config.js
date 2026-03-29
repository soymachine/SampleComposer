/**
 * config.js — Supabase credentials.
 *
 * SETUP (5 minutes):
 * ─────────────────
 * 1. Go to https://supabase.com → New Project
 * 2. Project Settings → API → copy "Project URL" and "anon public" key
 * 3. Paste them below
 * 4. Run the SQL at the bottom of cloud.js in your Supabase SQL Editor
 * 5. Storage → New bucket → name: "projects" (private)
 * 6. Storage → New bucket → name: "samples"  (private)
 * 7. (Optional) Authentication → Providers → enable Google OAuth
 *    Redirect URL for localhost: http://localhost:PORT
 *    Redirect URL for GitHub Pages: https://USERNAME.github.io/REPO/
 */
export const SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_PUBLIC_KEY';

/** Auto-detected: false until you fill in real credentials above */
export const SUPABASE_ENABLED  = (
  !SUPABASE_URL.includes('YOUR_PROJECT') &&
  !SUPABASE_ANON_KEY.includes('YOUR_ANON')
);
