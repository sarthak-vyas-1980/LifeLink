-- Apply this script in the SUPABASE project's SQL Editor.
-- This is intentionally separate from the Aiven PostgreSQL operational database.
-- The API uses the server-only SUPABASE_SECRET_KEY; never expose it to the browser.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.lifelink_rag_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  title text not null,
  source_type text not null,
  relative_path text not null,
  content_sha256 text not null,
  visibility_roles text[] not null default array['USER','ADMINISTRATOR','HOSPITAL_USER','BLOOD_BANK_USER','ORGAN_CENTRE_USER']::text[],
  status text not null default 'PENDING'
    check (status in ('PENDING','INDEXING','INDEXED','FAILED')),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  indexed_at timestamptz
);

create table if not exists public.lifelink_rag_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.lifelink_rag_sources(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  embedding extensions.vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, chunk_index)
);

create index if not exists lifelink_rag_chunks_embedding_hnsw_idx
  on public.lifelink_rag_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists lifelink_rag_chunks_source_chunk_idx
  on public.lifelink_rag_chunks (source_id, chunk_index);

create index if not exists lifelink_rag_sources_status_idx
  on public.lifelink_rag_sources (status);

create or replace function public.match_lifelink_rag_chunks(
  query_embedding extensions.vector(768),
  match_threshold double precision default 0.34,
  match_count integer default 6,
  allowed_roles text[] default array['USER']::text[]
)
returns table (
  id uuid,
  source_key text,
  title text,
  source_type text,
  content text,
  similarity double precision,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    s.source_key,
    s.title,
    s.source_type,
    c.content,
    (1 - (c.embedding <=> query_embedding))::double precision as similarity,
    c.metadata
  from public.lifelink_rag_chunks c
  join public.lifelink_rag_sources s on s.id = c.source_id
  where s.status = 'INDEXED'
    and s.visibility_roles && coalesce(allowed_roles, array[]::text[])
    and (1 - (c.embedding <=> query_embedding)) >= match_threshold
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 12);
$$;

alter table public.lifelink_rag_sources enable row level security;
alter table public.lifelink_rag_chunks enable row level security;

revoke all on table public.lifelink_rag_sources from anon, authenticated;
revoke all on table public.lifelink_rag_chunks from anon, authenticated;
grant usage on schema extensions to service_role;
grant all on table public.lifelink_rag_sources to service_role;
grant all on table public.lifelink_rag_chunks to service_role;

revoke all on function public.match_lifelink_rag_chunks(extensions.vector, double precision, integer, text[]) from public, anon, authenticated;
grant execute on function public.match_lifelink_rag_chunks(extensions.vector, double precision, integer, text[]) to service_role;

-- Ask PostgREST to reload its schema cache so the RPC becomes discoverable.
notify pgrst, 'reload schema';
