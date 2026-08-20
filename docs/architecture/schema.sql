-- Таблица documents — write-модель для пайплайна OCR+LLM
-- Статусная модель (state machine) для документа:
--   uploaded -> ocr_processing -> text_extracted -> extracting_entities
--     -> pending_review -> confirmed
--   На любом из шагов OCR/LLM возможен переход в needs_manual_review

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),

  -- В демо patient_id фиксированный тестовый пациент; в production —
  -- внешний ключ на таблицу patients, которой в этом MVP нет намеренно
  -- (не переусложняем демо тем, что не относится к сути сценария 2)
  patient_id uuid not null,

  storage_path text not null,          -- путь к файлу в Supabase Storage
  original_filename text not null,

  status text not null default 'uploaded'
    check (status in (
      'uploaded', 'ocr_processing', 'ocr_failed',
      'text_extracted', 'extracting_entities', 'extraction_failed',
      'pending_review', 'confirmed', 'needs_manual_review'
    )),

  -- Идемпотентность: клиент передаёт ключ на попытку загрузки.
  -- Повторный запрос с тем же ключом не создаёт вторую запись.
  idempotency_key text unique,

  extracted_text text,                 -- результат OCR
  extracted_entities jsonb,            -- результат LLM-извлечения:
                                        -- {date, diagnosis, doctor, medications: [...]}

  error_message text,                  -- если status = *_failed / needs_manual_review

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_status on documents(status);
create index if not exists idx_documents_patient on documents(patient_id);

-- Триггер обновления updated_at
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- ВАЖНО (ручной шаг, не через SQL): в Supabase Dashboard → Database →
-- Replication нужно включить Realtime для таблицы documents.
-- Это и есть наша замена Kafka: воркеры подписываются на изменения
-- этой таблицы вместо чтения из топика.
