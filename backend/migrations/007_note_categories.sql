-- User-managed note categories ("Website Template", "WhatsApp", ...). The old fixed `category` column becomes `kind`
-- (message = one copy button, email = subject + content).
CREATE TABLE note_categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  colour     VARCHAR(9) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_note_cat_name (name),
  CONSTRAINT fk_note_cat_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO note_categories (name, colour, sort_order, created_at, updated_at) VALUES
  ('WhatsApp', '#16a34a', 10, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('Email',    '#f59e0b', 20, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));

ALTER TABLE notes ADD COLUMN category_id INT UNSIGNED NULL AFTER id;
UPDATE notes n JOIN note_categories c ON c.name = IF(n.category = 'email', 'Email', 'WhatsApp') SET n.category_id = c.id;

ALTER TABLE notes DROP INDEX idx_notes_rank;
ALTER TABLE notes CHANGE COLUMN category kind VARCHAR(20) NOT NULL;
UPDATE notes SET kind = IF(kind = 'email', 'email', 'message');
ALTER TABLE notes
  ADD KEY idx_notes_cat (category_id, last_copied_at),
  ADD CONSTRAINT fk_notes_category FOREIGN KEY (category_id) REFERENCES note_categories(id);
