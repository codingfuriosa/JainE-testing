-- Run once in the Supabase SQL editor (project rkxsgtauigjrpcjkmccu) before deploying
-- transcription-ingest-index.ts. Adds the columns the DreamCRM -> JAIN-E automated
-- pipeline needs. Every column is nullable / defaulted so existing manual-upload rows
-- (source defaults to 'manual') are untouched.

alter table acc.transcriptions add column if not exists source text not null default 'manual';
alter table acc.transcriptions add column if not exists lead_id bigint;
alter table acc.transcriptions add column if not exists lead_mobile text;
alter table acc.transcriptions add column if not exists business_unit_name text;
alter table acc.transcriptions add column if not exists telephony_call_id bigint;
alter table acc.transcriptions add column if not exists recording_url text;
alter table acc.transcriptions add column if not exists non_transcribable_reason text;
alter table acc.transcriptions add column if not exists dashboard_fields jsonb;
alter table acc.transcriptions add column if not exists qa_evaluation jsonb;
alter table acc.transcriptions add column if not exists summary_verdict text;

create index if not exists idx_transcriptions_source on acc.transcriptions(source);
create index if not exists idx_transcriptions_lead_id on acc.transcriptions(lead_id);
