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
  unmet_topics TEXT,       -- matching short labels, same order, for grouping
  caller_type TEXT,        -- 'general' | 'business' | 'verify_callback' (from the call-start lookup)
  listing_update TEXT      -- what a business caller asked to change; held for review, never auto-applied
);
-- Added 2026-10-17 on an existing database:
-- ALTER TABLE calls ADD COLUMN unmet_requests TEXT; ALTER TABLE calls ADD COLUMN unmet_topics TEXT;
-- Added 2026-10-17 (business-caller lookup):
-- ALTER TABLE calls ADD COLUMN caller_type TEXT; ALTER TABLE calls ADD COLUMN listing_update TEXT;
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

-- Numbers that get a special greeting at call start (see src/initiate.js).
-- kind: 'verify' (Isla called them to check hours; expires after 14 days),
--       'business' (manual/test entry), 'fail_test' (makes /initiate fail on purpose, for testing).
CREATE TABLE IF NOT EXISTS caller_tags (
  phone_key TEXT NOT NULL,   -- last 10 digits
  name TEXT,
  kind TEXT NOT NULL,
  created_unix INTEGER NOT NULL,
  expires_unix INTEGER NOT NULL,
  PRIMARY KEY (phone_key, kind)
);

-- Isla's outbound hours-verification calls (one row per call; see /postcall).
CREATE TABLE IF NOT EXISTS verify_calls (
  conversation_id TEXT PRIMARY KEY,
  start_unix INTEGER NOT NULL,
  duration_secs INTEGER,
  phone TEXT,
  business TEXT,
  result TEXT,             -- e.g. voicemail, human, no-answer (ElevenLabs call_result / termination reason)
  summary TEXT
);

-- Neighbor Line caller texts (see src/nl_sms.js). Added 2026-10-24.
CREATE TABLE IF NOT EXISTS nl_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_unix INTEGER NOT NULL,
  phone TEXT,
  vendors TEXT,            -- comma-separated vendor ids from nl_vendors.json
  ok INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS nl_texts_phone ON nl_texts(phone, sent_unix);
