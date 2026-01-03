import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { serial_number, password } = await req.json()

    if (!serial_number || !password) {
      throw new Error('Serial number and password are required')
    }

    // Create a Supabase client with the Service Role Key (Admin access)
    // These env vars are automatically available in Supabase Edge Functions
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )

    console.log(`[PROVISION] Processing request for serial: ${serial_number}`);

    const sanitizedSerial = serial_number.replace(/:/g, '')
    const email = `device_${sanitizedSerial}@internal.sectorlink`

    // 1. Create the User in Supabase Auth
    const { data: userData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      user_metadata: { 
        role: 'device', 
        serial: serial_number 
      },
      email_confirm: true
    })

    if (createError) {
      console.error(`[PROVISION] Auth creation failed: ${createError.message}`);
      return new Response(
        JSON.stringify({ error: createError.message, details: createError }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400 
        }
      )
    }

    console.log(`[PROVISION] Successfully created user: ${userData.user.id}`);

    return new Response(
      JSON.stringify({ 
        message: 'Device provisioned successfully', 
        user_id: userData.user.id 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400 
      }
    )
  }
})
