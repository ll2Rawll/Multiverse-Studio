-- Books on the reading list. Demo rows have is_demo = 1 and can be removed
-- from the app ("Remove demo data") or with DELETE FROM books WHERE is_demo = 1.
CREATE TABLE books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  author      TEXT    NOT NULL DEFAULT '' CHECK (length(author) <= 120),
  status      TEXT    NOT NULL DEFAULT 'want' CHECK (status IN ('want', 'reading', 'done')),
  rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  notes       TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX books_status ON books (status);
