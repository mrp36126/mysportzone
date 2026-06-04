create table if not exists public.f1_favourites (
  id bigserial primary key,
  race_round text not null,
  race_name text not null,
  race_date date not null,
  driver_name text not null,
  constructor_name text not null,
  favourite_score numeric(5, 2) not null,
  form_score numeric(5, 2) not null,
  qualifying_score numeric(5, 2) not null,
  team_score numeric(5, 2) not null,
  track_score numeric(5, 2) not null,
  practice_score numeric(5, 2) not null,
  weather_score numeric(5, 2) not null,
  sentiment_score numeric(5, 2) not null,
  explanation text not null,
  updated_at timestamptz not null default now(),
  constraint f1_favourites_race_driver_unique unique (race_round, driver_name)
);

create index if not exists f1_favourites_race_score_idx
  on public.f1_favourites (race_round, favourite_score desc);
