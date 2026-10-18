-- "Allocated" = a temporary, priority hand-off of a lead to another user. It is separate from `assigned_to` (the lead's owner).
ALTER TABLE leads
  ADD COLUMN allocated_to INT UNSIGNED NULL,
  ADD COLUMN allocated_by INT UNSIGNED NULL,
  ADD COLUMN allocated_at DATETIME(3) NULL,
  ADD KEY idx_leads_allocated (allocated_to, allocated_at),
  ADD CONSTRAINT fk_leads_allocated_to FOREIGN KEY (allocated_to) REFERENCES users(id),
  ADD CONSTRAINT fk_leads_allocated_by FOREIGN KEY (allocated_by) REFERENCES users(id);
