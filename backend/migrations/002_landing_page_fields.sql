ALTER TABLE leads
  ADD COLUMN business_name VARCHAR(190) NULL AFTER nickname,
  ADD COLUMN requirement   VARCHAR(255) NULL AFTER business_name,
  ADD COLUMN budget        VARCHAR(100) NULL AFTER requirement;
