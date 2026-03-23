ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('user', 'agent', 'system', 'guest_agent', 'guest_human'));
