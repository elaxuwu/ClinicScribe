-- Run this in the Supabase SQL editor before using the dashboard.

create extension if not exists pgcrypto;

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  name_key text not null,
  patient_identifier text,
  age integer check (age is null or (age >= 0 and age <= 130)),
  gender text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name_key)
);

alter table public.patients
  add column if not exists patient_identifier text;

create table if not exists public.encounters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  legacy_note_id text,
  title text,
  transcript text,
  note_json jsonb not null default '{}'::jsonb,
  summary text,
  diagnosis text,
  visit_date timestamptz,
  language_detected text,
  provider_used text,
  pinned boolean not null default false,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists patients_user_name_idx
  on public.patients (user_id, name_key);

create unique index if not exists patients_user_identifier_idx
  on public.patients (user_id, patient_identifier)
  where patient_identifier is not null and patient_identifier <> '';

create index if not exists encounters_user_updated_idx
  on public.encounters (user_id, updated_at desc);

create index if not exists encounters_patient_updated_idx
  on public.encounters (patient_id, updated_at desc);

alter table public.patients enable row level security;
alter table public.encounters enable row level security;

drop policy if exists "Users can read their own patients" on public.patients;
create policy "Users can read their own patients"
  on public.patients
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own patients" on public.patients;
create policy "Users can create their own patients"
  on public.patients
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own patients" on public.patients;
create policy "Users can update their own patients"
  on public.patients
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own patients" on public.patients;
create policy "Users can delete their own patients"
  on public.patients
  for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read their own encounters" on public.encounters;
create policy "Users can read their own encounters"
  on public.encounters
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own encounters" on public.encounters;
create policy "Users can create their own encounters"
  on public.encounters
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own encounters" on public.encounters;
create policy "Users can update their own encounters"
  on public.encounters
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own encounters" on public.encounters;
create policy "Users can delete their own encounters"
  on public.encounters
  for delete
  using (auth.uid() = user_id);
