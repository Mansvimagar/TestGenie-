-- TestGenie -- syllabus knowledge base (RAG foundation)
-- Adds durable syllabus storage, structure-aware chunking, and pgvector
-- embeddings so generation can retrieve unit/topic-scoped context instead of
-- sending the entire syllabus to Gemini on every call.
--
-- Does NOT touch or replace 001_initial_schema.sql. Run this after it.

create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- syllabi  (one row per uploaded/pasted syllabus, independent of any test)
-- ---------------------------------------------------------------------------
create table if not exists public.syllabi (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  file_path text,
  source_type text not null check (source_type in ('pdf', 'manual')),
  raw_text text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'error')),
  page_count integer,
  processing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists syllabi_user_id_idx on public.syllabi(user_id);
create index if not exists syllabi_status_idx on public.syllabi(status);

alter table public.syllabi enable row level security;

create policy "syllabi_select_own" on public.syllabi
  for select using (auth.uid() = user_id);

create policy "syllabi_insert_own" on public.syllabi
  for insert with check (auth.uid() = user_id);

create policy "syllabi_update_own" on public.syllabi
  for update using (auth.uid() = user_id);

create policy "syllabi_delete_own" on public.syllabi
  for delete using (auth.uid() = user_id);

drop trigger if exists syllabi_set_updated_at on public.syllabi;
create trigger syllabi_set_updated_at
  before update on public.syllabi
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- syllabus_chunks  (structure-aware, embedded chunks used for RAG retrieval)
-- ---------------------------------------------------------------------------
-- Embedding dimension is 768 to match Gemini's text-embedding-004 model
-- (see lib/embeddings/index.ts). If the embedding model/provider changes to
-- one with a different output dimension, this column must be recreated
-- (pgvector's `vector` type has a fixed dimension per column) via a new
-- migration -- it cannot be safely `alter type`'d in place.
create table if not exists public.syllabus_chunks (
  id uuid primary key default gen_random_uuid(),
  syllabus_id uuid not null references public.syllabi(id) on delete cascade,
  unit text,
  topic text,
  subtopic text,
  content text not null,
  page_start integer,
  page_end integer,
  chunk_index integer not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(768),
  created_at timestamptz not null default now(),
  constraint syllabus_chunks_unique_index unique (syllabus_id, chunk_index)
);

create index if not exists syllabus_chunks_syllabus_id_idx
  on public.syllabus_chunks(syllabus_id);

create index if not exists syllabus_chunks_unit_topic_idx
  on public.syllabus_chunks(syllabus_id, unit, topic);

-- Approximate nearest-neighbour index for cosine similarity search.
-- HNSW is used (pgvector >= 0.5.0, supported on current Supabase Postgres
-- images) because it doesn't require a pre-populated table to build well,
-- unlike ivfflat. If your Supabase project's pgvector version is older than
-- 0.5.0, replace this block with:
--   create index ... using ivfflat (embedding vector_cosine_ops) with (lists = 100);
-- and run `analyze public.syllabus_chunks;` after chunks exist.
create index if not exists syllabus_chunks_embedding_idx
  on public.syllabus_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.syllabus_chunks enable row level security;

-- Faculty may only read/write chunks that belong to a syllabus they own.
-- Note: RLS still permits the owning faculty to select the `embedding`
-- column directly if they query this table over PostgREST -- the
-- application deliberately never does that (see lib/rag/retrieval.ts and
-- lib/embeddings/index.ts, which never return the raw vector to a browser
-- client). RLS here exists as defense-in-depth, not as the embedding's only
-- access control.
create policy "syllabus_chunks_select_own" on public.syllabus_chunks
  for select using (
    exists (
      select 1 from public.syllabi s
      where s.id = syllabus_id and s.user_id = auth.uid()
    )
  );

create policy "syllabus_chunks_insert_own" on public.syllabus_chunks
  for insert with check (
    exists (
      select 1 from public.syllabi s
      where s.id = syllabus_id and s.user_id = auth.uid()
    )
  );

create policy "syllabus_chunks_update_own" on public.syllabus_chunks
  for update using (
    exists (
      select 1 from public.syllabi s
      where s.id = syllabus_id and s.user_id = auth.uid()
    )
  );

create policy "syllabus_chunks_delete_own" on public.syllabus_chunks
  for delete using (
    exists (
      select 1 from public.syllabi s
      where s.id = syllabus_id and s.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- match_syllabus_chunks  (RPC used by lib/rag/retrieval.ts)
-- ---------------------------------------------------------------------------
-- Runs as the caller (not security definer), so RLS on syllabus_chunks still
-- applies -- a faculty member can only ever match chunks belonging to their
-- own syllabi, even though this function itself does not re-check user_id.
create or replace function public.match_syllabus_chunks(
  query_embedding vector(768),
  match_syllabus_id uuid,
  match_unit text default null,
  match_topic text default null,
  match_count int default 8
)
returns table (
  id uuid,
  syllabus_id uuid,
  unit text,
  topic text,
  subtopic text,
  content text,
  page_start integer,
  page_end integer,
  chunk_index integer,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.syllabus_id,
    c.unit,
    c.topic,
    c.subtopic,
    c.content,
    c.page_start,
    c.page_end,
    c.chunk_index,
    c.metadata,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.syllabus_chunks c
  where c.syllabus_id = match_syllabus_id
    and c.embedding is not null
    and (match_unit is null or c.unit = match_unit)
    and (match_topic is null or c.topic = match_topic)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
