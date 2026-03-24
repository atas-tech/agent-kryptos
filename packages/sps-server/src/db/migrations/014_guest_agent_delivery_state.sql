ALTER TABLE guest_intents
  ADD COLUMN IF NOT EXISTS agent_delivery_state TEXT
    CHECK (agent_delivery_state IN ('dispatched', 'failed')),
  ADD COLUMN IF NOT EXISTS agent_delivery_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS agent_delivery_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_delivery_last_dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_delivery_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (agent_delivery_attempt_count >= 0);

UPDATE guest_intents
SET agent_delivery_state = 'dispatched',
    agent_delivery_last_dispatched_at = COALESCE(agent_delivery_last_dispatched_at, activated_at, updated_at),
    agent_delivery_attempt_count = CASE
      WHEN agent_delivery_attempt_count > 0 THEN agent_delivery_attempt_count
      ELSE 1
    END,
    updated_at = now()
WHERE delivery_mode = 'agent'
  AND status = 'activated'
  AND exchange_id IS NOT NULL
  AND agent_delivery_state IS NULL;
