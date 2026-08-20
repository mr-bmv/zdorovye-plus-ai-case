import express, { Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { supabase, DOCUMENTS_BUCKET } from './supabaseClient.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — разумный лимит для скана
});

// Тестовый пациент для демо — в production здесь была бы аутентификация
// и patient_id брался бы из авторизованной сессии, не из тела запроса
const DEMO_PATIENT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * POST /documents
 *
 * Идемпотентность: клиент обязан передать заголовок Idempotency-Key —
 * уникальный идентификатор конкретной попытки загрузки (например,
 * сгенерированный на клиенте UUID перед отправкой запроса).
 *
 * Почему это ответственность клиента, а не сервера: если сеть оборвётся
 * после того, как сервер принял файл, но до того, как клиент получил
 * ответ, клиент не знает, дошёл ли запрос. Он повторяет попытку с тем
 * же Idempotency-Key. Сервер видит, что запись с таким ключом уже
 * существует, и возвращает её вместо создания дубликата — вместо того,
 * чтобы полагаться на хэш файла (два разных пациента могут случайно
 * загрузить идентичные по содержимому документы).
 */
app.post(
  '/documents',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Заголовок Idempotency-Key обязателен',
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не передан (поле "file")' });
    }

    // Шаг 1: проверяем, не обрабатывали ли мы уже этот запрос
    const { data: existing, error: lookupError } = await supabase
      .from('documents')
      .select('id, status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (lookupError) {
      console.error('Ошибка проверки идемпотентности:', lookupError);
      return res.status(500).json({ error: 'Внутренняя ошибка' });
    }

    if (existing) {
      // Повторный запрос — возвращаем существующую запись, не создаём новую
      return res.status(202).json({
        id: existing.id,
        status: existing.status,
        note: 'Документ уже был принят ранее (idempotent replay)',
      });
    }

    // Шаг 2: сохраняем файл в Storage
    const documentId = uuidv4();
    const storagePath = `${DEMO_PATIENT_ID}/${documentId}-${req.file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (uploadError) {
      console.error('Ошибка загрузки в Storage:', uploadError);
      return res.status(500).json({ error: 'Не удалось сохранить файл' });
    }

    // Шаг 3: создаём запись в Postgres. Именно эта запись — источник
    // события DocumentUploaded: воркеры подписаны на INSERT в эту
    // таблицу через Supabase Realtime (замена Kafka в MVP, см. decision
    // log в docs/architecture).
    const { data: doc, error: insertError } = await supabase
      .from('documents')
      .insert({
        id: documentId,
        patient_id: DEMO_PATIENT_ID,
        storage_path: storagePath,
        original_filename: req.file.originalname,
        status: 'uploaded',
        idempotency_key: idempotencyKey,
      })
      .select('id, status')
      .single();

    if (insertError) {
      console.error('Ошибка записи в БД:', insertError);
      // Файл уже в Storage, но записи нет — в production здесь нужна
      // компенсация (удалить файл или фоновая сверка orphan-файлов).
      // Явно отмечаем это как известное ограничение MVP.
      return res.status(500).json({
        error: 'Файл сохранён, но запись не создана — требуется ручная проверка',
      });
    }

    // 202 Accepted — обработка ещё не завершена, это то самое решение
    // "не блокировать пользователя ожиданием OCR/LLM"
    return res.status(202).json({ id: doc.id, status: doc.status });
  }
);

/**
 * GET /documents/:id/status
 * Простой polling-эндпоинт для демо-UI — без него фронту нечем было бы
 * узнать, что документ дошёл до pending_review.
 */
app.get('/documents/:id/status', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('documents')
    .select('id, status, extracted_entities, error_message')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Внутренняя ошибка' });
  if (!data) return res.status(404).json({ error: 'Документ не найден' });

  return res.json(data);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Document Upload Service слушает порт ${PORT}`);
});
