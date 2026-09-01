-- Hot Spot tracker — database schema
-- Run once in the Supabase SQL editor before the first deploy.
--
-- The previous release shipped without a schema file, so the unique constraints
-- that the upserts depend on (`on_conflict=draw_id`, `on_conflict=group_id,draw_id`)
-- had to be guessed. They are declared explicitly here: without them PostgREST
-- rejects every merge-duplicates write.

create table if not exists hotspot_draws (
  draw_id    bigint primary key,
  draw_date  text        not null,
  draw_time  text        not null,
  numbers    smallint[]  not null,
  bulls_eye  smallint,
  created_at timestamptz not null default now(),

  constraint hotspot_draws_twenty_numbers check (array_length(numbers, 1) = 20),
  constraint hotspot_draws_bulls_eye_range check (bulls_eye is null or (bulls_eye between 1 and 80))
);

create index if not exists hotspot_draws_draw_id_desc on hotspot_draws (draw_id desc);

-- Tracked 5-number groups, plus one non-active "control" row per cycle that
-- records where the 12-hour collection window started.
create table if not exists tracker_groups (
  id                serial primary key,
  name              text not null unique,
  numbers           smallint[] not null,
  active            boolean not null default false,
  start_draw_id     bigint,
  last_seen_draw_id bigint,
  -- Selection diagnostics for the cycle (candidates tested, chance benchmark,
  -- p-values). Stored so the dashboard can show how the groups were chosen
  -- without re-running the search on every page load.
  notes             jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists tracker_groups_active on tracker_groups (active, id);

create table if not exists tracker_results (
  id              bigserial primary key,
  group_id        integer not null references tracker_groups (id) on delete cascade,
  draw_id         bigint  not null,
  hit_count       smallint not null,
  hit_numbers     smallint[] not null default '{}',
  bulls_eye       smallint,
  bulls_eye_match boolean not null default false,
  created_at      timestamptz not null default now(),

  constraint tracker_results_unique unique (group_id, draw_id),
  constraint tracker_results_hit_range check (hit_count between 0 and 5)
);

create index if not exists tracker_results_group_draw on tracker_results (group_id, draw_id);

-- Advisory lock so two overlapping worker invocations cannot scrape and write
-- at the same time. Acquisition is a conditional UPDATE on expires_at.
create table if not exists tracker_locks (
  name       text primary key,
  holder     text,
  expires_at timestamptz not null default 'epoch'
);

-- The service role bypasses row level security, and nothing else should be able
-- to reach these tables directly. Enabling RLS with no permissive policy denies
-- anon and authenticated clients by default.
alter table hotspot_draws    enable row level security;
alter table tracker_groups   enable row level security;
alter table tracker_results  enable row level security;
alter table tracker_locks    enable row level security;
