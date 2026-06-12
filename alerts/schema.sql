-- Mass transit-alert service — Supabase schema.
-- Apply once (SQL editor or `supabase db push` / apply_migration).
--
-- Access model: RLS is ENABLED with NO policies — the tables are reachable
-- only with the service-role key (worker + edge functions). The browser
-- never talks to PostgREST directly; signup goes through the subscribe
-- edge function.

create table if not exists alert_users (
  id            uuid primary key default gen_random_uuid(),
  pushover_key  text not null unique,
  lat           double precision not null check (lat between -90 and 90),
  lon           double precision not null check (lon between -180 and 180),
  elev_m        double precision not null default 0,
  tz            text,                                   -- IANA, from the browser
  bodies        text[] not null default '{Sun,Moon}',
  min_elev_deg  double precision not null default 20,   -- engine floor is 20°
  confirmed     boolean not null default false,          -- double-opt-in
  disabled      boolean not null default false,          -- dead key / opt-out
  created_at    timestamptz not null default now()
);

create table if not exists alert_notified (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references alert_users(id) on delete cascade,
  sat          text not null,            -- 'ISS' | 'HST' | 'CSS'
  body         text not null,            -- 'Sun' | 'Moon'
  event_at_ms  bigint not null,          -- predicted closest approach (epoch ms)
  sent_at      timestamptz not null default now()
);

create index if not exists alert_notified_lookup
  on alert_notified (user_id, sat, body, event_at_ms);

alter table alert_users    enable row level security;
alter table alert_notified enable row level security;
