-- Shorter lead codes: LD-005 instead of LD-000005 (grows naturally past 999)
-- NOTE: LPAD() *truncates* values longer than its width, so ids >= 1000 must not go through it.
UPDATE leads SET lead_code = CONCAT('LD-', IF(id < 1000, LPAD(id, 3, '0'), CAST(id AS CHAR)));

-- Reusable message scripts (WhatsApp / email) shared by the team
CREATE TABLE notes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category       VARCHAR(20) NOT NULL,
  title          VARCHAR(150) NOT NULL,
  subject        VARCHAR(255) NULL,
  content        TEXT NOT NULL,
  copy_count     INT UNSIGNED NOT NULL DEFAULT 0,
  last_copied_at DATETIME(3) NULL,
  created_by     INT UNSIGNED NULL,
  updated_by     INT UNSIGNED NULL,
  created_at     DATETIME(3) NOT NULL,
  updated_at     DATETIME(3) NOT NULL,
  KEY idx_notes_rank (category, copy_count, updated_at),
  CONSTRAINT fk_notes_created FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_notes_updated FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
