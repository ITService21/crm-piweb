-- Starter services for quotations/invoices. Rows flagged is_default are pre-filled on every NEW document (still editable/removable);
-- the rest are one-tap "quick add" choices. Documents copy the values, so changing a preset never alters an existing document.
CREATE TABLE service_presets (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT NULL,
  unit_price  DECIMAL(14,2) NOT NULL,
  tax_rate    DECIMAL(7,3) NULL,
  is_default  TINYINT(1) NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL,
  updated_at  DATETIME(3) NOT NULL,
  UNIQUE KEY uq_preset_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO service_presets (name, unit_price, is_default, is_active, sort_order, created_at, updated_at) VALUES
  ('Website development & Testing',      12000.00, 1, 1, 10, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('Hosting Server + Domain (1 Year)',    2400.00, 1, 1, 20, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('Google Indexing & Basic SEO setup',   1200.00, 1, 1, 30, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
