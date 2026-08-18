create table if not exists public.finding_verifications (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  radar_id uuid not null references public.radars(id) on delete cascade,
  user_id uuid not null,
  attribute text not null,
  verdict text not null check (verdict in ('pass','fail','unknown')),
  note text,
  verification_source text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (finding_id, attribute, user_id)
);

grant select, insert, update, delete on public.finding_verifications to authenticated;
grant all on public.finding_verifications to service_role;

alter table public.finding_verifications enable row level security;

create policy "own verifications" on public.finding_verifications
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger finding_verifications_updated
  before update on public.finding_verifications
  for each row execute function public.update_updated_at_column();

alter table public.monitor_runs
  add column if not exists discovered_listings integer not null default 0,
  add column if not exists persisted_findings integer not null default 0,
  add column if not exists reverified_findings integer not null default 0;