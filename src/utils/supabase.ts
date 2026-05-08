import { createClient } from "@supabase/supabase-js";

// Supabase is the primary path. The fallback client only exists so the app can
// keep running in local guest mode if Supabase config is missing or unusable.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, "");
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const fallbackSupabaseUrl = "https://localhost.invalid";
const fallbackSupabaseKey = "local-fallback";

export const isSupabaseConfigured = Boolean(
  supabaseUrl?.startsWith("https://") && supabaseKey,
);
export const supabaseConfigErrorMessage =
  "Supabase is unavailable. ClinicScribe will fall back to local guest mode.";

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : fallbackSupabaseUrl,
  isSupabaseConfigured ? supabaseKey : fallbackSupabaseKey,
);
