// supabase/functions/email-alert/index.ts (Using Mailjet API - 6,000/month)
import { serve } from 'serve';

// Get secrets
const MAILJET_API_KEY = Deno.env.get('MAILJET_API_KEY');
const MAILJET_SECRET_KEY = Deno.env.get('MAILJET_SECRET_KEY');
const SENDER_EMAIL = Deno.env.get('SENDER_EMAIL');

// This function creates the API Key:Secret Key Base64 header for Mailjet
function getAuthHeader(apiKey: string, secretKey: string): string {
    const credentials = `${apiKey}:${secretKey}`;
    return `Basic ${btoa(credentials)}`;
}

serve(async (req) => {
    try {
        const payload = await req.json();
        const recipientEmail = "grant@icrs-pos.com"; // <<<--- YOUR RECIPIENT EMAIL GOES HERE!!!

        const emailData = {
            alert_type: payload.alert_type,
            puck_id: payload.puck_id,
            alert_message: payload.alert_message,
            created_at: payload.created_at
        };

        if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY || !SENDER_EMAIL) {
            console.error("Mailjet secrets missing. Cannot send alert.");
            return new Response(JSON.stringify({ error: "Missing Email Configuration" }), { status: 500 });
        }

        const isOffline = emailData.alert_type === 'OFFLINE';
        const subject = isOffline ? 
            `🚨 CRITICAL ALERT: Puck ${emailData.puck_id} OFFLINE` :
            `✅ RESOLVED: Puck ${emailData.puck_id} ONLINE`;

        const htmlContent = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd;">
                <h2 style="color: ${isOffline ? '#CC0000' : '#009933'};">${subject}</h2>
                <p><strong>Puck MAC:</strong> ${emailData.puck_id}</p>
                <p><strong>Message:</strong> ${emailData.alert_message}</p>
                <p><strong>Timestamp:</strong> ${new Date(emailData.created_at).toUTCString()}</p>
                <p style="margin-top: 20px; font-size: 10px; color: #888;">Dead Man's Switch Monitoring System</p>
            </div>
        `;

        const mailjetPayload = {
            Messages: [{
                From: { Email: SENDER_EMAIL, Name: "Puck Monitor" },
                To: [{ Email: recipientEmail }],
                Subject: subject,
                HTMLPart: htmlContent,
            }]
        };

        const authHeader = getAuthHeader(MAILJET_API_KEY, MAILJET_SECRET_KEY);

        const response = await fetch('https://api.mailjet.com/v3.1/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader // Use the Base64 header
            },
            body: JSON.stringify(mailjetPayload)
        });

        const responseBody = await response.json();

        if (response.ok) {
            console.log("Email alert sent successfully via Mailjet API.");
            return new Response(JSON.stringify({ message: "Email sent." }), { status: 200 });
        } else {
            console.error("Mailjet failed. Status:", response.status, "Error:", responseBody);
            return new Response(JSON.stringify({ error: "Mailjet API Error", details: responseBody }), { status: 500 });
        }

    } catch (error: any) {
        console.error("Email notifier failed:", error.message);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
});