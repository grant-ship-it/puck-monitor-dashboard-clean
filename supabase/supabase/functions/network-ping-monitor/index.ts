import { serve } from 'serve' 
import { createClient } from 'supabase-js'

// Initialize the Supabase client using environment variables
const supabase = createClient(
  // The service role key is correctly named SUPABASE_SERVICE_ROLE_KEY on the server
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, 
)

serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    
    // 1. Get the target URL from the request body
    const { targetUrl } = await req.json()
    if (!targetUrl) {
      throw new Error('Missing targetUrl in request body.')
    }
    
    // --- Network Ping and Measurement ---
    const startTime = Date.now();
    
    // Perform the actual network fetch
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Supabase-Edge-Monitor-Service'
      }
    });

    const endTime = Date.now();
    const latencyMs = endTime - startTime; 
    // ------------------------------------

    // 2. Insert data using the Service Role Key (bypassing RLS)
    const targetUserId = '00000000-0000-0000-0000-000000000000'; // Placeholder
    
    const { data, error } = await supabase
      .from('pings')
      .insert({
        user_id: targetUserId,
        target_url: targetUrl,
        status_code: response.status, 
        latency_ms: latencyMs,        
      })
      .select()

    if (error) throw error

    return new Response(
      JSON.stringify({ 
        message: `Ping recorded for ${targetUrl}.`,
        status: response.status,
        latency: `${latencyMs}ms`,
        inserted_data: data
      }),
      {
        status: 201, 
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred"

    return new Response(JSON.stringify({ error: `Ping Failed: ${errorMessage}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})