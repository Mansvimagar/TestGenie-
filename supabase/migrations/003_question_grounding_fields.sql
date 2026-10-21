-- TestGenie -- grounding & validation metadata on questions
-- Adds the columns needed for source traceability, grounding status, and
-- duplicate-detection results. Purely additive: every existing column,
-- constraint, index, and RLS policy from 001_initial_schema.sql is left
-- untouched, so the existing question editor and test-save flow keep
-- working with these columns simply defaulting to null/'not_applicable'.

alter table public.questions
  add column if not exists source_chunk_ids jsonb not null default '[]'::jsonb,
  add column if not exists grounding_status text not null default 'not_applicable'
    check (grounding_status in ('grounded', 'needs_review', 'unsupported', 'not_applicable')),
  add column if not exists validation_status text not null default 'not_applicable'
    check (validation_status in ('unique', 'duplicate', 'not_applicable')),
  add column if not exists validation_metadata jsonb not null default '{}'::jsonb;

comment on column public.questions.source_chunk_ids is
  'IDs of public.syllabus_chunks actually used as retrieval context for this question. Empty for legacy/manual-paste-without-RAG questions.';
comment on column public.questions.grounding_status is
  'Result of lib/validation/grounding.ts: grounded | needs_review | unsupported | not_applicable (no RAG context was available).';
comment on column public.questions.validation_status is
  'Result of lib/validation/duplicates.ts: unique | duplicate | not_applicable.';
comment on column public.questions.validation_metadata is
  'Similarity scores and debug details behind grounding_status/validation_status, e.g. {"groundingSimilarity": 0.81, "duplicateOfQuestionId": "..."}.';

-- Helpful for "show me anything that needs faculty attention" queries/UI.
create index if not exists questions_grounding_status_idx
  on public.questions(test_id, grounding_status);
