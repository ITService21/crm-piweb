-- All DATETIME columns store UTC. Business-timezone conversion happens in the app layer.

CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('admin','agent') NOT NULL DEFAULT 'agent',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE selectable_values (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category        VARCHAR(50) NOT NULL,
  value_key       VARCHAR(64) NOT NULL,
  label           VARCHAR(100) NOT NULL,
  description     VARCHAR(255) NULL,
  colour          VARCHAR(9) NULL,
  -- only meaningful for category = 'lead_status'; decides which sidebar section holds the lead
  status_category ENUM('active','not_interested','converted') NULL,
  -- only for active lead statuses: leads in this state get "new lead" priority
  is_new_state    TINYINT(1) NOT NULL DEFAULT 0,
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME(3) NOT NULL,
  updated_at      DATETIME(3) NOT NULL,
  UNIQUE KEY uq_sv_cat_key (category, value_key),
  KEY idx_sv_cat_order (category, is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leads (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_code        VARCHAR(20) NULL,
  created_at       DATETIME(3) NOT NULL,
  created_by       INT UNSIGNED NULL,
  status_id        INT UNSIGNED NOT NULL,
  enquiry_type_id  INT UNSIGNED NULL,
  source_id        INT UNSIGNED NULL,
  email            VARCHAR(190) NULL,
  phone            VARCHAR(20) NULL,
  nickname         VARCHAR(120) NULL,
  message          TEXT NULL,
  next_followup_at DATETIME(3) NULL,
  last_action_by   INT UNSIGNED NULL,
  last_action_at   DATETIME(3) NOT NULL,
  special_markup_id INT UNSIGNED NULL,
  assigned_to      INT UNSIGNED NULL,
  last_remark_text TEXT NULL,
  last_remark_by   INT UNSIGNED NULL,
  last_remark_at   DATETIME(3) NULL,
  remarks_count    INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at       DATETIME(3) NOT NULL,
  updated_by       INT UNSIGNED NULL,
  UNIQUE KEY uq_leads_code (lead_code),
  KEY idx_leads_status_followup (status_id, next_followup_at),
  KEY idx_leads_followup (next_followup_at),
  KEY idx_leads_created (created_at),
  KEY idx_leads_assigned (assigned_to),
  KEY idx_leads_phone (phone),
  KEY idx_leads_email (email),
  CONSTRAINT fk_leads_status   FOREIGN KEY (status_id)         REFERENCES selectable_values(id),
  CONSTRAINT fk_leads_enquiry  FOREIGN KEY (enquiry_type_id)   REFERENCES selectable_values(id),
  CONSTRAINT fk_leads_source   FOREIGN KEY (source_id)         REFERENCES selectable_values(id),
  CONSTRAINT fk_leads_markup   FOREIGN KEY (special_markup_id) REFERENCES selectable_values(id),
  CONSTRAINT fk_leads_created  FOREIGN KEY (created_by)        REFERENCES users(id),
  CONSTRAINT fk_leads_lastact  FOREIGN KEY (last_action_by)    REFERENCES users(id),
  CONSTRAINT fk_leads_assigned FOREIGN KEY (assigned_to)       REFERENCES users(id),
  CONSTRAINT fk_leads_updated  FOREIGN KEY (updated_by)        REFERENCES users(id),
  CONSTRAINT fk_leads_remarkby FOREIGN KEY (last_remark_by)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lead_remarks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id     BIGINT UNSIGNED NOT NULL,
  remark_text TEXT NOT NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME(3) NOT NULL,
  KEY idx_remarks_lead (lead_id, created_at),
  CONSTRAINT fk_remarks_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_remarks_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only: the API exposes no update/delete path for this table.
CREATE TABLE lead_activities (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id       BIGINT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL,
  action_type   VARCHAR(40) NOT NULL,
  summary       VARCHAR(500) NOT NULL,
  before_data   JSON NULL,
  after_data    JSON NULL,
  created_at    DATETIME(3) NOT NULL,
  KEY idx_act_lead (lead_id, created_at),
  CONSTRAINT fk_act_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_act_user FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Transactional outbox: rows are inserted in the same transaction as the lead.
CREATE TABLE event_outbox (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_uuid   CHAR(36) NOT NULL,
  event_type   VARCHAR(40) NOT NULL,
  lead_id      BIGINT UNSIGNED NOT NULL,
  payload      JSON NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  published_at DATETIME(3) NULL,
  UNIQUE KEY uq_outbox_uuid (event_uuid),
  KEY idx_outbox_pending (published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  event_id   BIGINT UNSIGNED NOT NULL,
  lead_id    BIGINT UNSIGNED NOT NULL,
  read_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_notif_user_event (user_id, event_id),
  KEY idx_notif_unread (user_id, read_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_preferences (
  user_id               INT UNSIGNED NOT NULL PRIMARY KEY,
  sound_enabled         TINYINT(1) NOT NULL DEFAULT 1,
  browser_notifications TINYINT(1) NOT NULL DEFAULT 0,
  updated_at            DATETIME(3) NOT NULL,
  CONSTRAINT fk_pref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
