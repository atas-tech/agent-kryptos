-- Migration 007: Rename Stripe-specific billing columns to provider-agnostic names
-- and add a billing_provider discriminator column.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_provider TEXT DEFAULT NULL
    CHECK (billing_provider IN ('stripe', 'x402'));

-- Rename Stripe-specific columns to generic names.
-- PostgreSQL RENAME COLUMN preserves existing indexes and constraints automatically.
ALTER TABLE workspaces RENAME COLUMN stripe_customer_id TO billing_provider_customer_id;
ALTER TABLE workspaces RENAME COLUMN stripe_subscription_id TO billing_provider_subscription_id;

-- Backfill billing_provider for workspaces that already have a customer ID
UPDATE workspaces
  SET billing_provider = 'stripe'
  WHERE billing_provider_customer_id IS NOT NULL
    AND billing_provider IS NULL;
