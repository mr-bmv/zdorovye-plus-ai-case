import { createClient } from '@supabase/supabase-js';

// SERVICE_ROLE ключ, не anon — сервис пишет напрямую в таблицу и storage
// от имени системы, минуя RLS-политики, которые в production будут
// защищать прямой доступ пациентов к чужим документам.
// Ключи никогда не коммитятся — только через переменные окружения (.env,
// который в .gitignore).
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY должны быть заданы в .env'
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

export const DOCUMENTS_BUCKET = 'documents';
