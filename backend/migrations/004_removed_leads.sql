-- Soft removal: a removed lead stays in the table (history intact) but is hidden from every tab except "Removed".
ALTER TABLE leads
  ADD COLUMN removed_at     DATETIME(3) NULL,
  ADD COLUMN removed_by     INT UNSIGNED NULL,
  ADD COLUMN removed_reason TEXT NULL,
  ADD KEY idx_leads_removed (removed_at),
  ADD CONSTRAINT fk_leads_removed_by FOREIGN KEY (removed_by) REFERENCES users(id);
