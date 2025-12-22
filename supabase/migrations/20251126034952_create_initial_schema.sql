-- Create a table called 'pings' to store network check data
create table public.pings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now() not null,
  user_id uuid references auth.users (id) not null,
  target_url text not null,
  status_code int,
  latency_ms int
);

-- Enable Row Level Security (RLS) on the table. This is essential for secure Supabase usage.
alter table public.pings enable row level security;

-- RLS Policy: Allow authenticated users to view only their own pings.
create policy "Users can only view their own pings."
on public.pings for select
to authenticated
using (auth.uid() = user_id);

-- RLS Policy: Allow authenticated users to insert pings tied to their ID.
create policy "Users can insert their own pings."
on public.pings for insert
to authenticated
with check (auth.uid() = user_id);