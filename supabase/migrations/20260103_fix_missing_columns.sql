-- Migration: Ensure all columns exist for Agent v1.4.0
-- This script adds missing columns to 'pucks' and 'devices' tables

-- 1. PUCKS TABLE
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pucks' AND column_name='software_version') THEN
        ALTER TABLE public.pucks ADD COLUMN software_version TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pucks' AND column_name='wifi_ssid') THEN
        ALTER TABLE public.pucks ADD COLUMN wifi_ssid TEXT;
    END IF;
END $$;

-- 2. DEVICES TABLE
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='ip_address') THEN
        ALTER TABLE public.devices ADD COLUMN ip_address TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='manufacturer') THEN
        ALTER TABLE public.devices ADD COLUMN manufacturer TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='is_monitored') THEN
        ALTER TABLE public.devices ADD COLUMN is_monitored BOOLEAN DEFAULT true;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='location') THEN
        ALTER TABLE public.devices ADD COLUMN location TEXT;
    END IF;
END $$;
