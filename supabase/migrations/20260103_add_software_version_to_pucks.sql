-- Migration: Add software_version to pucks table
ALTER TABLE public.pucks ADD COLUMN IF NOT EXISTS software_version TEXT;
