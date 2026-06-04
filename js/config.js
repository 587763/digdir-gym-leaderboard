// Supabase connection config.
//
// These two values are SAFE to commit publicly. The publishable key is designed
// to be shipped in client code — all real protection comes from Row Level
// Security policies in the database (see supabase/schema.sql), not from hiding it.
// Never put the *secret* key (sb_secret_...) here.
//
// Find these in: Supabase dashboard → Settings → API Keys (publishable key)
// and Settings → Data API (Project URL).
window.LEADERBOARD_CONFIG = {
  SUPABASE_URL: 'https://hqrqmkherwdkfvhjypuk.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dTZMDmmYoRz0rHNmwopwkA_bLahQzrY',
};
