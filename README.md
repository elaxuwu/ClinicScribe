# ClinicScribe
ClinicScribe is an AI medical scribe for clinics and/or patients that records doctor-patient conversations, transcribes them in real time, and generates structured notes, visit summaries, and simple discharge instructions.

## Supabase setup

ClinicScribe uses Supabase Auth for user accounts and Supabase Postgres for patient dashboard records.

1. Add the Vite env vars from `.env.example` to `.env`.
2. Run the SQL in `supabase/schema.sql` in the Supabase SQL editor.
3. Add server env vars from `.dev.vars.example` to `.dev.vars` for Cloudflare local functions, or to Cloudflare Pages if deploying:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`

## Upstash environment

Upstash Redis is still used by the Cloudflare Pages Functions layer for temporary audio/legacy note data while AI endpoints run.

- `UPSTASH_DATABASE_URL`: Upstash Redis HTTPS REST URL
- `UPSTASH_DATABASE_KEY`: Upstash Redis REST token
