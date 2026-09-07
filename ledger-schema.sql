-- Signal ledger. Run once in the Supabase SQL editor.
--
-- One row per EPISODE, not per check. A signal that stays STRONG across several
-- draws is one event; the unique constraint plus the contiguity rule in
-- lib/signal-ledger.js keep it that way.

create table if not exists signal_episodes (
  id                  bigserial primary key,
  target              text     not null,          -- "9-15-56-75-79"
  status              text     not null,          -- STRONG, MEDIUM, ...
  expected_tier       text,
  four_plus_score     smallint,
  signal_numbers      smallint[] not null default '{}',

  start_draw_id       bigint   not null,
  last_draw_id        bigint   not null,
  -- Fixed when the episode opens. It must never be moved forward as the signal
  -- persists, or a long-running signal gets unlimited chances inside a promise
  -- of five draws.
  window_end_draw_id  bigint   not null,

  resolved            boolean  not null default false,
  best_hit_count      smallint,
  outcome_draw_id     bigint,
  success             boolean,
  lead_draws          smallint,
  created_at          timestamptz not null default now(),

  constraint signal_episodes_unique unique (target, status, start_draw_id),
  constraint signal_episodes_hit_range check (best_hit_count is null or best_hit_count between 0 and 5)
);

create index if not exists signal_episodes_open    on signal_episodes (resolved, window_end_draw_id);
create index if not exists signal_episodes_target  on signal_episodes (target, start_draw_id desc);

alter table signal_episodes enable row level security;
