-- Adds a stable Google Forms response key so webhook retries update the same
-- TestGenie score instead of creating duplicate rows. Existing/manual scores
-- remain valid with NULL response IDs. Review against the target live schema
-- before applying; this migration is not executed by the application.

alter table public.scores
  add column if not exists google_response_id text;

create unique index if not exists scores_test_google_response_id_uidx
  on public.scores(test_id, google_response_id);

comment on column public.scores.google_response_id is
  'Google Forms response ID used to make score ingestion retries idempotent.';
