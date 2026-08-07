-- Append-only archive of channel actions (issue #2). AUTOINCREMENT is load-bearing:
-- seq is the consumer's cursor, and rowid reuse after deletes would replay under it.
CREATE TABLE actions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  chat       TEXT    NOT NULL,
  kind       TEXT    NOT NULL, -- send | edit | pin | unpin
  message_id INTEGER NOT NULL,
  text       TEXT,             -- rendered HTML as sent to Telegram; NULL for pin/unpin
  silent     INTEGER,          -- 1 = disable_notification (send only)
  tier       TEXT              -- major | normal | minor, where the source has one
);
CREATE INDEX actions_ts ON actions (ts);

-- Album photos, bytes as posted (Telegram gets uploads, not URLs).
CREATE TABLE photos (
  action_seq INTEGER NOT NULL REFERENCES actions (seq),
  idx        INTEGER NOT NULL,
  media_type TEXT    NOT NULL,
  bytes      BLOB    NOT NULL,
  PRIMARY KEY (action_seq, idx)
);
