-- Optional guardrails for the private Lawncare Manager app.
-- Run this only after the lead capture SQL and manager tables already exist.
-- If a policy already exists, Supabase will tell you. You can skip that duplicate policy.

alter table public.lawncare_quotes enable row level security;
alter table public.lawncare_jobs enable row level security;
alter table public.lawncare_settings enable row level security;

create policy "Authenticated users manage quotes"
on public.lawncare_quotes
for all
to authenticated
using (true)
with check (true);

create policy "Authenticated users manage jobs"
on public.lawncare_jobs
for all
to authenticated
using (true)
with check (true);

create policy "Authenticated users manage settings"
on public.lawncare_settings
for all
to authenticated
using (true)
with check (true);

-- Useful indexes
create index if not exists idx_lawncare_leads_created_at on public.lawncare_leads(created_at desc);
create index if not exists idx_lawncare_leads_status on public.lawncare_leads(status);
create index if not exists idx_lawncare_jobs_scheduled_date on public.lawncare_jobs(scheduled_date);
create index if not exists idx_lawncare_jobs_status on public.lawncare_jobs(job_status);
create index if not exists idx_lawncare_quotes_lead_id on public.lawncare_quotes(lead_id);
