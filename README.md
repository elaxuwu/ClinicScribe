# ClinicScribe
ClinicScribe is an AI medical scribe for clinics and/or patients that records doctor-patient conversations, transcribes them in real time, and generates structured notes, visit summaries, and simple discharge instructions.

## Auth environment

The account system uses Upstash Redis from the Cloudflare Pages Functions layer.

- `UPSTASH_DATABASE_URL`: Upstash Redis HTTPS REST URL
- `UPSTASH_DATABASE_KEY`: Upstash Redis REST token

Optional:

- `NOTE_UPSTREAM_TIMEOUT_MS`: note-generation provider timeout in milliseconds, clamped between 5000 and 90000. Defaults to 60000.
