# transcription-sync — how it actually runs

This is the automated **nightly Lost-Call QA** batch job. It is a separate thing from the manual
"Upload a call recording" button in the app's Transcription module (that goes through
`transcription-upload` / `transcription-analyze`, two other edge functions that live in the Supabase
project, not in this repo). This function runs on its own, on a schedule, over CRM-reported calls.

One edge function, one URL, four possible `action`s:

```
POST https://<your-project>.supabase.co/functions/v1/transcription-sync
Content-Type: application/json
Authorization: Bearer <token>        (or) x-sync-secret: <value from acc.job_secrets>

{ "action": "run" | "pull" | "work" | "retry" | "status", ... }
```

`action: "run"` (what the nightly cron actually calls) does `pull` then `work` in one request.
Everything below walks through what each step does and every external URL it hits.

---

## Step 0 — who's allowed to call this

The function checks, in order:
1. `x-sync-secret` header against `acc.job_secrets` (a token the database generated for itself —
   what pg_cron sends), or against the legacy `SYNC_SECRET` env var. This is the cron route and is
   unaffected by point 2 below — cron isn't a user.
2. Failing that, an `Authorization: Bearer <token>` from a signed-in user, verified against
   Supabase Auth — but only accepted if that user's email matches `MANUAL_TRIGGER_EMAIL` (env var
   `SYNC_MANUAL_EMAIL`, default `digitalmarketing@thejaingroup.com`). Any other genuinely signed-in
   user gets a `403` (they proved who they are, it's just not permitted) on **every** action,
   including read-only `status` — this was a deliberate choice to keep the rule to one line rather
   than special-casing which actions "count."

No credential at all → `401`.

Then it checks it has the API key it's about to need: `CHATGPT_API_KEY` (or `OPENAI_API_KEY`) if
`engine` is `"chatgpt"` (the default), `GEMINI_API_KEY` if `engine` is `"gemini"`.

---

## Step 1 — `pull`: get the day's calls from the CRM

```
GET https://www.realtybucket.com/report/lost_call_recordings?from=YYYY-MM-DD&to=YYYY-MM-DD
```

(URL overridable via `LOST_CALL_FEED` env var.) This is DreamCRM's report endpoint — no API key,
just a date range. It returns a JSON array of rows: `recording_url, lead_id, lead_name,
business_unit_name, status, next_follow_up_date, lost_reason, remarks`.

**As soon as the feed responds**, the whole raw array — before any filtering — is uploaded as a
one-day audit snapshot:
```
PUT (Storage) transcription-feeds/<from>.json      (private bucket, upsert, application/json)
```
This upload is non-fatal (a failure is logged, never blocks the pull) and the file is deleted again
once the rest of this step finishes (success or failure) — it exists only as a same-day audit copy
of exactly what the CRM sent, not a permanent archive. See the one-time bucket-creation SQL below.

For each row:
- Only `status` of `Lost` or `In Followup` is kept — everything else (`Qualified`, `Sit Visited`,
  `OV`, ...) is discarded here, before anything costs money.
- Rows with no `recording_url` ("None") become a `no_recording` row with no further processing.
- Duplicates (same call UUID, extracted from the URL's `callid=` param, or already in the DB) are
  skipped.
- Everything else gets inserted into `acc.transcriptions` with `status: "queued"`.

No AI is called in this step. It's pure fetch-and-queue. Logged to `acc.lost_call_sync_runs`.

---

## Step 2 — `work`: process a batch of queued calls

Pulls up to `limit` (default 3, max 24) rows where `status = "queued"`, claims them
(`status → "processing"`) so a second overlapping run doesn't grab the same rows, then processes
them **one at a time, sequentially** (`CONCURRENCY = 1` — was 3; changed on request, and it also
suits the heavier combined Gemini call better than running several at once). For **each** call, in
order:

### 2.1 — Fetch the recording

```
GET <row.recording_url>          (Knowlarity's URL, redirects to a presigned S3 link, ~600s TTL)
```

Read fully into memory. Rejected if under 1KB (empty) or over 20MB. **Never written to disk** —
lives in memory for exactly this request. Content-Type is trusted only if it actually looks like
`audio/*` or `video/*`; Knowlarity often serves `binary/octet-stream`, which is forced to
`audio/mpeg` instead (a bug fixed earlier: passing that content-type through made Gemini treat the
audio as an unlabelled blob and answer from the prompt text instead of listening to it).

### 2.2 — Duration check

Duration is estimated from the MP3 header/bitrate directly (no decoding). ≤ 60 seconds →
stop here, `status: "too_short"`, no AI call made (almost certainly a ring-out).

### 2.3 — Stage 1, the ear (and, for Gemini, the judge too)

The two engines are genuinely different shapes now, not just different vendors for the same job:

**If `engine: "chatgpt"` (default) — still two separate calls, unchanged:**
```
POST https://api.openai.com/v1/audio/transcriptions
Authorization: Bearer <CHATGPT_API_KEY>
Content-Type: multipart/form-data

file=<audio bytes, named "call.mp3">
model=gpt-4o-transcribe
response_format=json
temperature=0
prompt=<STT_HINT — project names, area names, "speech mixes Bengali/Hindi/English">
```
Response: `{ "text": "<verbatim transcript>" }`. Judging happens separately in step 2.5.

**If `engine: "gemini"` (on a fresh listen — no stored transcript yet) — ONE combined call:**

⚠️ This is a deliberate, flagged departure from the two-call design ChatGPT still uses. The
top-of-file comment in `index.ts` documents why the two-call split existed in the first place (a
combined call once produced correct customer names on 0 of 20 calls, out of 175) — this was
re-adopted for Gemini anyway, on request, after that history was raised twice. The content checks
in step 2.4 below are what still catch bad output without the old structural protection.

```
POST https://generativelanguage.googleapis.com/upload/v1beta/files?key=<GEMINI_API_KEY>
X-Goog-Upload-Protocol: multipart
Content-Type: multipart/related; boundary=<generated>

--<boundary>
Content-Type: application/json; charset=UTF-8

{"file":{"displayName":"<call file name>.mp3"}}
--<boundary>
Content-Type: audio/mpeg

<raw audio bytes>
--<boundary>--
```
Response: `{ "file": { "name": "files/abc123", "uri": "https://generativelanguage.googleapis.com/v1beta/files/abc123", ... } }`.
Then, using that `uri`, ONE call that both transcribes and judges:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=<GEMINI_API_KEY>
Content-Type: application/json

{
  "contents": [{ "parts": [
    { "text": "<GEMINI_COMBINED_PROMPT + CRM context — verbatim-listen instructions, THEN the full QA rubric + project catalogue>" },
    { "file_data": { "mime_type": "audio/mpeg", "file_uri": "<uri from upload>" } }
  ]}],
  "generationConfig": { "temperature": 0, "maxOutputTokens": 60000, "response_mime_type": "application/json" }
}
```
Response JSON comes from `candidates[0].content.parts[0].text` and already contains everything
step 2.5 describes below (`transcript_original`, `criteria`, `qa_evaluation`, etc.) — `parsed` is
set here, and step 2.5 is skipped entirely for this call. Then, immediately, regardless of whether
the call above succeeded or threw:
```
DELETE https://generativelanguage.googleapis.com/v1beta/files/abc123?key=<GEMINI_API_KEY>
```
(best-effort — Google auto-deletes anything left behind after 48h anyway).

**Re-judging an already-`stored` transcript** (any retry where Stage 1 already succeeded on an
earlier attempt) always uses the cheaper, text-only judge call in step 2.5, for *either* engine —
combining calls only ever applies to a fresh listen, never to a re-judge, so that optimization
wasn't lost.

### 2.4 — Clean the transcript

Purely local, no API calls: strip the recorded IVR greeting ("Welcome to Jain Group...", "this call
will be recorded..."), fix known Bengali place-name mis-hearings ("Poylan" → "Pailan", etc.), then
run two content checks:
- **Stuck-loop check** — one word making up ≥60% of an 8+ word transcript → flagged, not trusted.
- **Too-thin check** — under 120 characters, or under 1.5 characters per second of audio → treated
  as a failure to hear, not a fact about the call. `status: "non_transcribable"`, transcript
  cleared, and it goes back in the queue (up to 3 attempts).

### 2.5 — Stage 2, the judge: transcript text → structured verdict

**Skipped entirely if step 2.3 already produced a judged result** — a fresh Gemini listen did the
judging in the same call (see 2.3). This step only runs for a ChatGPT fresh listen, or for either
engine re-judging an already-`stored` transcript. Same cleaned transcript text goes in, whichever
engine is active also runs this stage (never mixed). Only the text goes in — never the audio, never
the CRM's own name or status for this lead (only its lost-reason/remarks, if any, as something to
be *checked against*, not trusted).

**If `engine: "chatgpt"`:**
```
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <CHATGPT_API_KEY>
Content-Type: application/json

{
  "model": "gpt-4o",
  "temperature": 0,
  "response_format": { "type": "json_object" },
  "max_tokens": 16000,
  "messages": [
    { "role": "system", "content": "<ANALYSE_PROMPT — full QA rubric + project catalogue>" },
    { "role": "user", "content": "VERBATIM TRANSCRIPT:\n\n<transcript>[+ CRM's lost reason/remarks if any]" }
  ]
}
```
Response JSON string is in `choices[0].message.content`.

**If `engine: "gemini"`:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=<GEMINI_API_KEY>
Content-Type: application/json

{
  "contents": [{ "parts": [
    { "text": "<ANALYSE_PROMPT>\n\nVERBATIM TRANSCRIPT:\n\n<transcript>[+ CRM context]" }
  ]}],
  "generationConfig": { "temperature": 0, "maxOutputTokens": 16000, "response_mime_type": "application/json" }
}
```
Response JSON string is in `candidates[0].content.parts[0].text`.

Either way, the parsed JSON contains: speaker-labelled turns (original + English), `customer_name`,
`project_discussed`, `languages`, `dashboard_fields` (number asked, pincode, lead category, lost
reason), `criteria` (7 booleans), `qa_evaluation` (7 scored points), `summary_verdict`, and — if the
CRM's own lost-reason/remarks were sent in — a `discrepancy_check` comparing the two.

### 2.6 — Turn everything into a verdict (no API calls, all local logic)

- **Qualification** (`Qualified` / `Follow-Up` / `Not Qualified`) is computed by fixed rule from the
  7 criteria booleans — never taken from whatever label the model itself proposed.
- **CRM mismatch** — does the CRM's `Lost`/`In Followup` status agree with what the call actually
  shows? (e.g. marked Lost but the call shows real buying intent → flagged high-severity.)
- **Name check** — does the name heard on the call match the CRM's name for this lead?
- **Follow-up date check** — does this call's date match what an earlier call for the same lead
  said the next follow-up should be?
- **Discrepancy checks** — lost-reason match, remarks match, and (always) whether the transcript
  itself looked like a stuck-loop failure.

### 2.7 — Save

```
UPDATE acc.transcriptions SET status='done', transcript_en=..., transcript_bn=..., qualification=...,
  criteria=..., qa_evaluation=..., mismatch=..., discrepancy=..., gladia_id=<engine>, ... WHERE id=...
```
(`gladia_id` is a repurposed old column — it just records which engine produced the row, for
comparing ChatGPT vs Gemini runs later.)

If Stage 2 fails after Stage 1 succeeded, the transcript is saved anyway with `status: "error"` —
a retry only redoes the (cheaper, already-failed) judging, not the transcription that already
worked.

---

## Other actions

- **`retry`** — `{ "action": "retry", "id": 123 }`. Resets that row's attempt counter to 0 and
  status to `"queued"` (transcript kept, not cleared), then immediately runs `work` with `limit: 1`
  so it's picked up in the same request.
- **`status`** — `{ "action": "status" }`. No AI calls — just counts of rows per status
  (`queued`/`processing`/`done`/`non_transcribable`/`no_recording`/`too_short`/`error`), the last
  pull run's stats, and the current default model names.

## Picking the engine per call

Add to the request body: `"engine": "gemini"` (default is `"chatgpt"`). Optional model overrides,
all validated as model-name-shaped strings:

| Field | Applies to | Default |
|---|---|---|
| `stt_model` (or `model`) | ChatGPT stage 1 | `gpt-4o-transcribe` |
| `analysis_model` | ChatGPT stage 2 | `gpt-4o` |
| `gemini_model` | Gemini's combined call (fresh listen) | `gemini-2.5-pro` |
| `gemini_analysis_model` | Gemini's text-only judge (re-judge only) | `gemini-2.5-pro` |

Both stages always use the same engine — the code never lets one vendor's transcript get judged by
the other vendor. The code's own default stays `"chatgpt"`; the nightly cron and the app's Sync Now
button both pass `"engine": "gemini"` explicitly so the combined flow is actually what runs day to
day — see the setup SQL below.

---

## One-time setup (run once in the Supabase SQL editor — nothing here lives in this repo)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;

insert into acc.job_secrets (name, value)
values ('transcription_sync', encode(gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- 18:30 UTC = 00:00 IST, every day - istYesterday() then resolves to "the day that just ended".
select cron.schedule(
  'transcription-sync-nightly',
  '30 18 * * *',
  $$
  select net.http_post(
    url := 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/transcription-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select value from acc.job_secrets where name = 'transcription_sync')
    ),
    body := jsonb_build_object('action', 'run', 'engine', 'gemini')
  );
  $$
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transcription-feeds', 'transcription-feeds', false, 10485760, array['application/json'])
on conflict (id) do nothing;
```

No Storage RLS policy is needed on that bucket — the function always uses the service-role client,
which bypasses Storage RLS. To change or remove the schedule later: `select
cron.unschedule('transcription-sync-nightly');`.

## Known trade-off: retrying a fresh Gemini call is now all-or-nothing

Before this change, a call whose transcription succeeded but whose judging failed retried cheaply —
text-only, no re-listen. That's still true for ChatGPT, and for re-judging any already-`stored`
transcript on either engine. But once a *fresh* Gemini call goes through the combined flow, a
validation failure (stuck-loop, too-thin-for-duration) throws away the transcription cost and the
judging cost together, since they happened in one request — there's no cheaper "just re-listen"
partial retry for Gemini any more on a first attempt. This is a direct, accepted consequence of
combining the calls, not a bug.
