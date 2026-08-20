// Supabase Edge Function: transcription-ingest
// Deployed to project rkxsgtauigjrpcjkmccu (JainE). This file is the source of
// record for the team — keep it in sync with the deployed function.
//
// Server-to-server intake for the DreamCRM -> JAIN-E automated transcription pipeline.
// DreamCRM (Rails) pushes ONE call at a time: { recording_url, lead_id, lead_mobile,
// business_unit_name, telephony_call_id, duration }. This function fetches the recording
// into memory only, sends it straight to Gemini for transcription + QA analysis, stores
// the structured result in acc.transcriptions (source: "dreamcrm_auto"), and discards the
// audio — nothing is ever written to S3 or any other storage by this function.
//
// Auth: a shared secret, NOT a Supabase user session — DreamCRM's rake task is not a
// logged-in browser user, so it can't produce a Supabase auth JWT the way the browser app does.
//
// Requires Secrets: DREAMCRM_INGEST_SECRET, GEMINI_API_KEY (+ platform SUPABASE_* vars).
// Run supabase/dreamcrm_auto_transcription.sql once (in the Supabase SQL editor) before
// deploying this function — it adds the columns this function writes to.

import { createClient } from "jsr:@supabase/supabase-js@2";

const j = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

const PROMPT = `### ROLE
You are an expert Sales Quality Assurance Analyst.

### CRITICAL PRE-CHECK (READ FIRST)
Before performing any tasks, listen to the audio.
1. If the call contains ONLY ringing, caller tunes, busy signals, IVR recordings (e.g., "The number is busy"), or silence with no human conversation between an Agent and a Customer, STOP IMMEDIATELY.
2. In this case, return ONLY the following JSON structure and nothing else:
{
  "status": "Non-Transcribable",
  "reason": "[Insert specific reason: Caller Tune/Busy/Switch Off/No Conversation]",
  "transcript": [],
  "dashboard_fields": null,
  "qa_evaluation": [],
  "summary_verdict": "Call discarded due to lack of human conversation."
}

### TASK 1: TRANSCRIPTION (IF CONVERSATION EXISTS)
Transcribe the audio end-to-end in the ORIGINAL language spoken (Hindi, Bengali, English, or whatever mix the speakers used — do NOT translate to English).
- Maintain strict speaker diarization between Agent and Customer.
- Include a timestamp in MM:SS format for every speaker turn.
- Do not summarize, skip, merge, or paraphrase any turn.
- Output the transcript as a JSON ARRAY (not a string) — each element is an object with three keys: speaker, timestamp, text.

### TASK 2: DASHBOARD FIELD MAPPING
Extract specific data points for the following table columns:
1. number_asked: Did the agent ask for the customer's phone number? ("Yes" / "No")
2. pincode_provided: Did the agent ask for or verify a pincode? Provide the value if shared, otherwise "None".
3. lead_category: Categorize the lead as ONLY one of: 'Not Interested', 'Qualified', 'Interested Not Qualified', 'Interested Site Visit', 'Interested in Booking'.
4. lost_reason: If the customer was not interested, the specific reason. Otherwise "None".

### TASK 3: AGENT QA AUDIT
Evaluate the agent on these 7 criteria. Status must be "Pass", "Fail", or "Partial".
- Script: Proper opening/closing and following the required talk track.
- Etiquette: Professionalism, greeting, no interruptions.
- Query Handling: Accurate and helpful responses to questions.
- Call to Action: Defining a clear next step before hanging up.
- Leakage Avoidance: Lead remains in our funnel without unnecessary info sharing.
- Follow-up Accuracy: Confirming a specific date and time for the next call.
- Hyper-personalization: Tailoring the pitch based on the customer's specific mentions (profession, family, location, budget, preferences, etc.).

### OUTPUT FORMAT
Return ONLY valid JSON. If conversational, use this exact structure. No markdown fences, no extra commentary, no extra fields. The "transcript" value must be a JSON array, not a string.

{
  "transcript": [
    {"speaker": "Agent",    "timestamp": "00:00", "text": "..."},
    {"speaker": "Customer", "timestamp": "00:05", "text": "..."}
  ],
  "dashboard_fields": {
    "number_asked": "Yes/No",
    "pincode_provided": "value or None",
    "lead_category": "Not Interested | Qualified | Interested Not Qualified | Interested Site Visit | Interested in Booking",
    "lost_reason": "specific reason or None"
  },
  "qa_evaluation": [
    {"point": "Script",              "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Etiquette",           "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Query Handling",      "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Call to Action",      "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Leakage Avoidance",   "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Follow-up Accuracy",  "status": "Pass/Fail/Partial", "evidence": "...", "notes": "..."},
    {"point": "Hyper-personalization","status": "Pass/Fail/Partial","evidence": "...", "notes": "..."}
  ],
  "summary_verdict": "Short summary of agent performance."
}`;

function qualificationFor(category: string | null | undefined): string | null {
  if (!category) return null;
  const c = String(category).toLowerCase();
  if (c === "not interested") return "Not Qualified";
  return "Qualified"; // Qualified / Interested Not Qualified / Interested Site Visit / Interested in Booking
}

async function recordFailure(
  db: ReturnType<typeof createClient>,
  base: Record<string, unknown>,
  message: string,
) {
  const { data, error } = await db.schema("acc").from("transcriptions").insert({
    ...base,
    source: "dreamcrm_auto",
    status: "error",
    error_text: message.slice(0, 500),
  }).select("*").single();
  if (error) return j({ error: error.message }, 500);
  return j({ ok: true, row: data });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return j({ error: "method not allowed" }, 405);

  const SB = Deno.env.get("SUPABASE_URL")!;
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("DREAMCRM_INGEST_SECRET");
  const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!SECRET || token !== SECRET) return j({ error: "unauthorized" }, 401);
  if (!GEMINI_KEY) return j({ error: "GEMINI_API_KEY not configured in Secrets" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const recordingUrl = String(body.recording_url || "");
  const leadId = body.lead_id ?? null;
  const leadMobile = body.lead_mobile ?? null;
  const businessUnitName = body.business_unit_name ?? null;
  const telephonyCallId = body.telephony_call_id ?? null;
  const duration = Number(body.duration || 0);

  if (!recordingUrl) return j({ error: "missing recording_url" }, 400);
  if (!leadId) return j({ error: "missing lead_id" }, 400);
  if (duration && duration <= 60) return j({ error: "duration must be > 60s" }, 400);

  const db = createClient(SB, SRV);
  const base = {
    lead_id: leadId,
    lead_mobile: leadMobile,
    business_unit_name: businessUnitName,
    telephony_call_id: telephonyCallId,
    recording_url: recordingUrl,
    duration_seconds: duration || null,
    file_name: "call_" + (telephonyCallId || leadId),
  };

  // ---- fetch the recording into memory only; nothing is ever written to storage ----
  let audioB64 = "";
  let mimeType = "audio/mpeg";
  try {
    const rec = await fetch(recordingUrl);
    if (!rec.ok) throw new Error("recording fetch failed (" + rec.status + ")");
    mimeType = rec.headers.get("content-type") || mimeType;
    const buf = new Uint8Array(await rec.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    audioB64 = btoa(bin);
  } catch (e) {
    return recordFailure(db, base, String((e as any)?.message || e));
  }
  // audioB64 lives only in this request's memory and is discarded when the function returns.

  try {
    const gr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: audioB64 } }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      },
    );
    const gj = await gr.json().catch(() => ({}));
    if (!gr.ok) throw new Error("Gemini call failed (" + gr.status + "): " + JSON.stringify(gj).slice(0, 300));

    const raw: string = gj?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const isNonTranscribable = parsed.status === "Non-Transcribable";
    const category = parsed?.dashboard_fields?.lead_category;

    const row = {
      ...base,
      source: "dreamcrm_auto",
      status: isNonTranscribable ? "non_transcribable" : "done",
      qualification: isNonTranscribable ? null : qualificationFor(category),
      non_transcribable_reason: isNonTranscribable ? (parsed.reason || null) : null,
      transcript: isNonTranscribable ? null : (parsed.transcript || null),
      dashboard_fields: parsed.dashboard_fields || null,
      qa_evaluation: parsed.qa_evaluation || null,
      summary_verdict: parsed.summary_verdict || null,
    };

    const { data, error } = await db.schema("acc").from("transcriptions").insert(row).select("*").single();
    if (error) return j({ error: error.message }, 500);
    return j({ ok: true, row: data });
  } catch (e) {
    return recordFailure(db, base, String((e as any)?.message || e));
  }
});
