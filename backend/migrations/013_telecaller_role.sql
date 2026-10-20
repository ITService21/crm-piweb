-- New read-only billing role. Telecallers work leads like agents do, but cannot create or change quotations / invoices / payments.
ALTER TABLE users MODIFY COLUMN role ENUM('admin','agent','telecaller') NOT NULL DEFAULT 'agent';
