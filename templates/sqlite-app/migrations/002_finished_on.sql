-- When a book was finished (set automatically when status becomes 'done').
ALTER TABLE books ADD COLUMN finished_on TEXT;
