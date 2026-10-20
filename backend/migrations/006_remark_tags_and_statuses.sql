-- Tags that can be attached to remarks ("Call not picked", "Busy", ...). Tag values live in selectable_values (category 'remark_tag')
-- so they get Settings management, colours, ordering and safe deactivation for free.
CREATE TABLE lead_remark_tags (
  remark_id BIGINT UNSIGNED NOT NULL,
  tag_id    INT UNSIGNED NOT NULL,
  PRIMARY KEY (remark_id, tag_id),
  KEY idx_remark_tags_tag (tag_id),
  CONSTRAINT fk_rt_remark FOREIGN KEY (remark_id) REFERENCES lead_remarks(id) ON DELETE CASCADE,
  CONSTRAINT fk_rt_tag    FOREIGN KEY (tag_id)    REFERENCES selectable_values(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lets the list show the latest remark's tags without scanning remarks
ALTER TABLE leads ADD COLUMN last_remark_id BIGINT UNSIGNED NULL;
UPDATE leads l SET last_remark_id = (SELECT MAX(r.id) FROM lead_remarks r WHERE r.lead_id = l.id);

INSERT IGNORE INTO selectable_values (category, value_key, label, colour, status_category, is_new_state, sort_order, is_active, created_at, updated_at) VALUES
  ('remark_tag', 'call_not_picked',   'Call not picked',   '#ef4444', NULL, 0, 10, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'busy',              'Busy',              '#f59e0b', NULL, 0, 20, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'callback_requested','Callback requested','#0ea5e9', NULL, 0, 30, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'details_sent',      'Details sent',      '#6366f1', NULL, 0, 40, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'interested',        'Interested',        '#16a34a', NULL, 0, 50, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'wrong_number',      'Wrong number',      '#64748b', NULL, 0, 60, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('remark_tag', 'switched_off',      'Switched off',      '#a855f7', NULL, 0, 70, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));

-- Two more lead statuses (both Active, so they accept follow-ups). Rename, recolour, move or reorder them in Settings.
INSERT IGNORE INTO selectable_values (category, value_key, label, colour, status_category, is_new_state, sort_order, is_active, created_at, updated_at) VALUES
  ('lead_status', 'few_days_later',  'Few Days Later',  '#0ea5e9', 'active', 0, 42, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  ('lead_status', 'least_interested','Least Interested','#94a3b8', 'active', 0, 44, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
