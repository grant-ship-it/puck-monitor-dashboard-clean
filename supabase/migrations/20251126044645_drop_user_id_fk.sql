-- Remove the foreign key constraint that links pings.user_id to auth.users.id
alter table public.pings drop constraint pings_user_id_fkey;

-- We are keeping the RLS policy for demonstration, even though the Service Role key bypasses it.