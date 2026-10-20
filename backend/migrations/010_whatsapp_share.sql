-- Unguessable per-document link (created on demand when someone shares the PDF, e.g. via WhatsApp) + a record of how documents were sent.
ALTER TABLE billing_documents
  ADD COLUMN share_token CHAR(32) NULL,
  ADD UNIQUE KEY uq_doc_share (share_token);

ALTER TABLE document_emails
  ADD COLUMN channel ENUM('email','whatsapp') NOT NULL DEFAULT 'email',
  MODIFY COLUMN status ENUM('sent','failed','opened') NOT NULL; -- 'opened' = WhatsApp was opened with the message; delivery is up to the person pressing Send
