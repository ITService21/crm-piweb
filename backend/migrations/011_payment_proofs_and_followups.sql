-- Payment proof files (screenshots/PDFs the client sends). The files live on disk (UPLOAD_DIR); only metadata is stored here.
CREATE TABLE payment_attachments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id    BIGINT UNSIGNED NOT NULL,
  document_id   BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(80) NOT NULL,
  mime          VARCHAR(100) NOT NULL,
  size_bytes    INT UNSIGNED NOT NULL,
  uploaded_by   INT UNSIGNED NULL,
  created_at    DATETIME(3) NOT NULL,
  UNIQUE KEY uq_att_stored (stored_name),
  KEY idx_att_payment (payment_id),
  KEY idx_att_doc (document_id),
  CONSTRAINT fk_att_payment FOREIGN KEY (payment_id)  REFERENCES invoice_payments(id),
  CONSTRAINT fk_att_doc     FOREIGN KEY (document_id) REFERENCES billing_documents(id),
  CONSTRAINT fk_att_user    FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The date by which the client has promised to pay next. Unlike the locked invoice due date it is a working
-- field for payment follow-ups, so it can be changed after issuing.
ALTER TABLE billing_documents
  ADD COLUMN next_payment_due DATE NULL,
  ADD KEY idx_doc_next_due (doc_type, next_payment_due);
