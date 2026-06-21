-- Lawncare lead photo support
-- Run this in the same Supabase project used by both apps.
-- It creates a private Storage bucket plus a metadata table that links images to leads.

-- 1) Private bucket for uploaded lead photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lawncare-lead-images',
  'lawncare-lead-images',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

-- 2) Metadata table. The image bytes live in Storage; this table links them to the lead.
create table if not exists public.lawncare_lead_images (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.lawncare_leads(id) on delete cascade,
  created_at timestamptz not null default now(),

  bucket_id text not null default 'lawncare-lead-images',
  storage_path text not null,
  file_name text,
  mime_type text not null,
  file_size integer not null,
  sort_order integer not null default 0,
  uploaded_by_role text not null default 'anon',

  constraint lawncare_lead_images_bucket_check
    check (bucket_id = 'lawncare-lead-images'),
  constraint lawncare_lead_images_storage_path_check
    check (storage_path ~ '^leads/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+$'),
  constraint lawncare_lead_images_mime_check
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  constraint lawncare_lead_images_file_size_check
    check (file_size > 0 and file_size <= 8388608),
  constraint lawncare_lead_images_uploaded_by_check
    check (uploaded_by_role in ('anon', 'authenticated'))
);

create index if not exists lawncare_lead_images_lead_id_idx
on public.lawncare_lead_images (lead_id, sort_order, created_at);

create unique index if not exists lawncare_lead_images_storage_path_idx
on public.lawncare_lead_images (storage_path);

alter table public.lawncare_lead_images enable row level security;

grant insert on public.lawncare_lead_images to anon;
grant select, insert, update, delete on public.lawncare_lead_images to authenticated;

-- 3) RLS for image metadata.
drop policy if exists "Anyone can attach photos to a submitted lawncare lead" on public.lawncare_lead_images;
create policy "Anyone can attach photos to a submitted lawncare lead"
on public.lawncare_lead_images
for insert
to anon
with check (
  bucket_id = 'lawncare-lead-images'
  and uploaded_by_role = 'anon'
  and storage_path like ('leads/' || lead_id::text || '/%')
  and mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  and file_size > 0
  and file_size <= 8388608
);

drop policy if exists "Authenticated users can manage lead photo records" on public.lawncare_lead_images;
create policy "Authenticated users can manage lead photo records"
on public.lawncare_lead_images
for all
to authenticated
using (true)
with check (true);

-- 4) Storage policies.
-- Public/anonymous visitors may upload images only into the lead photo bucket.
-- They cannot read, update, list, or delete objects.
drop policy if exists "Anon can upload lawncare lead photos" on storage.objects;
create policy "Anon can upload lawncare lead photos"
on storage.objects
for insert
to anon
with check (
  bucket_id = 'lawncare-lead-images'
  and (storage.foldername(name))[1] = 'leads'
  and array_length(storage.foldername(name), 1) = 3
  and lower(name) ~ '\.(jpg|jpeg|png|webp|heic|heif)$'
);

-- Authenticated manager users can preview/download images through signed URLs.
drop policy if exists "Authenticated users can read lawncare lead photos" on storage.objects;
create policy "Authenticated users can read lawncare lead photos"
on storage.objects
for select
to authenticated
using (bucket_id = 'lawncare-lead-images');

-- Authenticated manager users can clean up images if a lead is spam or deleted.
drop policy if exists "Authenticated users can manage lawncare lead photos" on storage.objects;
create policy "Authenticated users can manage lawncare lead photos"
on storage.objects
for all
to authenticated
using (bucket_id = 'lawncare-lead-images')
with check (bucket_id = 'lawncare-lead-images');
