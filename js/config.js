// Supabase connection config.
//
// These two values are SAFE to commit publicly. The anon key is designed to be
// shipped in client code — all real protection comes from Row Level Security
// policies in the database (see supabase/schema.sql), not from hiding this key.
//
// To fill these in: Supabase dashboard → your project → Settings → API.
//   Project URL  -> SUPABASE_URL
//   anon public  -> SUPABASE_ANON_KEY
window.LEADERBOARD_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_PUBLIC_KEY',
};
