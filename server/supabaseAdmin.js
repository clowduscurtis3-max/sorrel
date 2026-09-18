const { createClient } = require('@supabase/supabase-js');

// Uses the service_role secret key, which bypasses Row Level Security.
// This client must never be used outside this backend.
module.exports = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
