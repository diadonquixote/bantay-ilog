-- Bantay Ilog schema for Supabase (Postgres).
-- Run in the Supabase SQL editor, then create a private storage bucket named
-- "gauge-photos" (or set SUPABASE_PHOTO_BUCKET). The server uses the service
-- role key, so RLS is enabled with no public policies: nothing is readable
-- with the anon key.
--
-- Upgrading an existing database? Run supabase/migrations/001_hardening.sql.

create table if not exists stations (
  id                 text primary key check (id ~ '^[a-z0-9-]+$'),
  name               text not null,
  river              text not null default '',
  location           text not null default '',
  gauge_min          numeric not null default 0,
  gauge_max          numeric not null default 20,
  threshold_alert    numeric not null,
  threshold_alarm    numeric not null,
  threshold_critical numeric not null,
  tolerance          numeric not null default 0.1 check (tolerance > 0),
  max_rate_per_hour  numeric not null default 2 check (max_rate_per_hour > 0),
  evacuation_center  text not null default '',
  hotline            text not null default '',
  team_chat_ids      text[] not null default '{}',
  created_at         timestamptz not null default now(),
  check (threshold_alert < threshold_alarm and threshold_alarm < threshold_critical),
  check (gauge_min < gauge_max)
);

create table if not exists readings (
  id               uuid primary key,
  station_id       text not null references stations(id) on delete cascade,
  client_id        text,
  taken_at         timestamptz not null,
  created_at       timestamptz not null default now(),
  source           text not null check (source in ('photo', 'manual', 'telegram', 'demo')),
  ai_level         numeric,
  ai_confidence    numeric,
  ai_notes         text,
  observer_level   numeric,
  observer_name    text,
  -- Stable identity of the sender, so the two-person rule can't be beaten by
  -- retyping your own name differently.
  observer_key     text,
  level            numeric,
  status           text not null check (status in ('accepted', 'needs_confirmation', 'rejected')),
  status_reason    text not null default '',
  photo_path       text,
  photo_hash       text,
  confirmed_by     text,
  confirmed_by_key text,
  unique (station_id, client_id)
);
create index if not exists readings_station_time on readings (station_id, taken_at desc);
create index if not exists readings_station_status on readings (station_id, status, taken_at desc);
create index if not exists readings_photo_hash on readings (station_id, photo_hash) where photo_hash is not null;

create table if not exists alerts (
  id          uuid primary key,
  station_id  text not null references stations(id) on delete cascade,
  reading_id  uuid references readings(id) on delete set null,
  level       text not null check (level in ('normal', 'alert', 'alarm', 'critical')),
  kind        text not null default 'stage'
                check (kind in ('stage', 'early', 'provisional', 'de-escalation', 'all-clear')),
  message     text not null,
  origin      text not null check (origin in ('agent', 'rule')),
  recipients  integer not null default 0,
  -- Two requests racing each other cannot both send the same alert: the second
  -- insert loses on this constraint before anything reaches a resident.
  dedupe_key  text not null unique,
  created_at  timestamptz not null default now()
);
create index if not exists alerts_station_time on alerts (station_id, created_at desc);

create table if not exists subscribers (
  chat_id     text not null,
  station_id  text not null references stations(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now(),
  primary key (chat_id, station_id)
);

create table if not exists advisories (
  id          uuid primary key,
  warning     text not null check (warning in ('none', 'yellow', 'orange', 'red', 'unknown')),
  text        text not null default '',
  source      text not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists advisories_time on advisories (fetched_at desc);

create table if not exists reminders (
  id          uuid primary key,
  station_id  text not null references stations(id) on delete cascade,
  due_at      timestamptz not null,
  reason      text not null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists reminders_due on reminders (due_at) where sent_at is null;

create table if not exists outbox (
  id          uuid primary key,
  chat_id     text not null,
  text        text not null,
  delivered   boolean not null,
  error       text,
  retries     integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists outbox_time on outbox (created_at desc);
create index if not exists outbox_pending on outbox (created_at) where delivered = false and retries > 0;

-- Small key/value store: last successful background tick, etc.
create table if not exists meta (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table stations    enable row level security;
alter table readings    enable row level security;
alter table alerts      enable row level security;
alter table subscribers enable row level security;
alter table advisories  enable row level security;
alter table reminders   enable row level security;
alter table outbox      enable row level security;
alter table meta        enable row level security;

-- Seed stations (same defaults as the local store).
insert into stations (id, name, river, location, gauge_min, gauge_max, threshold_alert, threshold_alarm, threshold_critical, tolerance, team_chat_ids)
values
  ('sto-nino', 'Sto. Niño Gauge', 'Marikina River', 'Sto. Niño bridge, Marikina City', 10, 22, 15, 16, 17, 0.1, '{}'),
  ('demo', 'Demo Gauge', 'Demo River', 'Simulated station for the /demo page', 0, 6, 3, 4, 5, 0.1, '{demo-team}')
on conflict (id) do nothing;
