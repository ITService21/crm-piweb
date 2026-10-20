-- Service presets can carry a default discount (e.g. 100% for complimentary items), and the standard service list is extended.
ALTER TABLE service_presets
  ADD COLUMN discount_type  ENUM('none','percent','amount') NOT NULL DEFAULT 'none' AFTER tax_rate,
  ADD COLUMN discount_value DECIMAL(14,3) NULL AFTER discount_type;

-- Website development: 12,000 -> 14,000, but only if nobody has already edited the price in Settings.
UPDATE service_presets SET unit_price = 14000.00, updated_at = UTC_TIMESTAMP(3)
 WHERE name = 'Website development & Testing' AND unit_price = 12000.00;

-- Hosting is complimentary (100% discount) unless it was already changed.
UPDATE service_presets SET discount_type = 'percent', discount_value = 100, updated_at = UTC_TIMESTAMP(3)
 WHERE name = 'Hosting Server + Domain (1 Year)' AND unit_price = 2400.00 AND discount_type = 'none';

-- Order on new documents: Website, Google Indexing, Hosting, Site Maintenance, Landing Page.
UPDATE service_presets SET sort_order = 20 WHERE name = 'Google Indexing & Basic SEO setup' AND sort_order = 30;
UPDATE service_presets SET sort_order = 30 WHERE name = 'Hosting Server + Domain (1 Year)' AND sort_order = 20;

INSERT IGNORE INTO service_presets (name, unit_price, discount_type, discount_value, is_default, is_active, sort_order, created_at, updated_at) VALUES
  ('Site Maintenance',     3000.00, 'percent', 100, 1, 1, 40, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('Website Landing Page', 8000.00, 'percent', 100, 1, 1, 50, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
