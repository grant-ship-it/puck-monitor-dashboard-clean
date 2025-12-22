-- Re-add the Foreign Key constraint. 
-- If a user_id is provided, it must reference a valid user in the auth.users table.
-- If a user_id is NOT provided (it is NULL), this constraint is ignored.
alter table public.pings add constraint pings_user_id_fkey foreign key (user_id) references auth.users(id);