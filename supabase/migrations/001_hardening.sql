-- Upgrade an existing Bantay Ilog database to the hardened schema.
-- Safe to run more than once.

alter table stations add column if not exists max_rate_per_hour numeric not null default 2;
alter table stations add column if not exists evacuation_center text not null default '';
alter table stations add column if not exists hotline           text not null default '';

alter table readings add column if not exists observer_key     text;
alter table readings add column if not exists photo_hash       text;
alter table readings add column if not exists confirmed_by_key text;
create index if not exists readings_photo_hash on readings (station_id, photo_hash) where photo_hash is not null;

alter table alerts add column if not exists kind text not null default 'stage';
alter table alerts add column if not exists dedupe_key text;
-- Existing rows get their own key so the unique index can be created.
update alerts set dedupe_key = id::text where dedupe_key is null;
alter table alerts alter column dedupe_key set not null;
create unique index if not exists alerts_dedupe_key on alerts (dedupe_key);
do $$ begin
  alter table alerts add constraint alerts_kind_check
    check (kind in ('stage', 'early', 'provisional', 'de-escalation', 'all-clear'));
exception when duplicate_object then null; end $$;

alter table outbox add column if not exists retries integer not null default 0;
create index if not exists outbox_pending on outbox (created_at) where delivered = false and retries > 0;

create table if not exists meta (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table meta enable row level security;
