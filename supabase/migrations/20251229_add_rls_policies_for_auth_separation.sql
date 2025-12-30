-- Migration: Add RLS Policies for Authentication Separation
-- Purpose: Restrict anon users (dashboard) to SELECT-only access
--          while allowing service role (Pi) full access

-- ============================================================
-- DEVICES TABLE
-- ============================================================

-- Enable RLS on devices table
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- Allow anon users to SELECT (read-only)
CREATE POLICY "Anon users can view devices"
ON public.devices FOR SELECT
TO anon
USING (true);

-- ============================================================
-- PUCKS TABLE
-- ============================================================

-- Enable RLS on pucks table
ALTER TABLE public.pucks ENABLE ROW LEVEL SECURITY;

-- Allow anon users to SELECT (read-only)
CREATE POLICY "Anon users can view pucks"
ON public.pucks FOR SELECT
TO anon
USING (true);

-- ============================================================
-- COMMANDS TABLE
-- ============================================================

-- Enable RLS on commands table
ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;

-- Allow anon users to SELECT (read-only)
CREATE POLICY "Anon users can view commands"
ON public.commands FOR SELECT
TO anon
USING (true);

-- ============================================================
-- STATUS_LOGS TABLE
-- ============================================================

-- Enable RLS on status_logs table
ALTER TABLE public.status_logs ENABLE ROW LEVEL SECURITY;

-- Allow anon users to SELECT (read-only)
CREATE POLICY "Anon users can view status_logs"
ON public.status_logs FOR SELECT
TO anon
USING (true);

-- ============================================================
-- NOTES
-- ============================================================
-- 1. Service role key automatically bypasses RLS, so no policies needed for it
-- 2. These policies allow anon users to SELECT all rows (USING true)
-- 3. Anon users CANNOT INSERT, UPDATE, or DELETE (no policies for those operations)
-- 4. User-level filtering happens in the application layer based on customer_id
