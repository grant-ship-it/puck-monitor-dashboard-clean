-- Allow user_id to be NULL. This is required to drop the NOT NULL constraint 
-- if it was present on the original column definition.
alter table public.pings alter column user_id drop not null;