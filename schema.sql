-- Isla call log (D1 database "isla-calls"). Run once in the D1 console; safe to re-run.
CREATE TABLE IF NOT EXISTS calls (
  conversation_id TEXT PRIMARY KEY,
  start_unix INTEGER NOT NULL,
  duration_secs INTEGER,
  phone TEXT,
  source TEXT,
  name TEXT,
  email TEXT,
  locations TEXT,
  title TEXT,
  summary TEXT,
  text_places TEXT,
  text_ok INTEGER,         -- 1 sent, 0 failed, NULL no text / unknown
  unmet_requests TEXT,     -- " | "-separated requests Isla couldn't satisfy (post-call analysis)
  unmet_topics TEXT        -- matching short labels, same order, for grouping
);
-- Added 2026-10-17 on an existing database:
-- ALTER TABLE calls ADD COLUMN unmet_requests TEXT; ALTER TABLE calls ADD COLUMN unmet_topics TEXT;
CREATE INDEX IF NOT EXISTS calls_start ON calls(start_unix);
CREATE INDEX IF NOT EXISTS calls_phone ON calls(phone);

CREATE TABLE IF NOT EXISTS texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_unix INTEGER NOT NULL,
  phone TEXT,
  places TEXT,
  ok INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS texts_phone ON texts(phone, sent_unix);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,      -- 'link' (one-time, 15 min) or 'session' (30 days)
  expires_unix INTEGER NOT NULL
);
