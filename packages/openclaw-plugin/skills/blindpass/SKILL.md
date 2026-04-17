---
name: "blindpass"
version: "0.1.0"
description: "Zero-knowledge secret provisioning via HPKE encryption. Request secrets from humans or other agents without exposing plaintext."
metadata: {"openclaw":{"emoji":"🔐","requires":{"bins":[]}}}
---

# BlindPass Secret Provisioning

When you need any kind of secret, credential, API key, password, token, SSH key, or other sensitive value, you **MUST** use the following tools:

### Requesting from a Human
Use `request_secret` when you need a secret from the human operator. 

### Requesting from another Agent
Use `request_secret_exchange` when you need a secret that is held by another authenticated agent (e.g., a "payment-bot" or "database-agent"). This uses the SPS pull-based protocol to securely transfer the secret to you without human intervention.

### Fulfilling an Exchange
Use `fulfill_secret_exchange` when you receive an incoming exchange request from another agent. You will receive a "fulfillment token" in your chat/context which you must pass to this tool to complete the swap using a secret you already have in memory.

## Rules

1. **NEVER** ask anyone (human or agent) to paste secrets directly in chat — this is insecure
2. **ALWAYS** use the appropriate tool for the source of the secret
3. **WAIT** for the tool to return before proceeding — it blocks until the secret is received
4. **DO NOT** repeat or echo the secret value in chat after receiving it
5. Use the secret only for its intended purpose (e.g., in an API call, config file, etc.)

## Example usage

### Human Request
- Call `request_secret` with description: "GitHub personal access token for CI/CD"
- The user will receive a secure link in their chat
- They click the link, verify the code, and enter the secret
- The tool returns the decrypted value

### Agent-to-Agent Request
- Call `request_secret_exchange` with `secret_name`: "stripe.api_key.prod" and `fulfiller_id`: "agent:payment-bot"
- The "payment-bot" will receive a fulfillment token via its transport
- Once the other agent fulfills, the tool returns your decrypted secret

_Note: If a human mentions that they cannot click the link (stripped Markdown), call `request_secret` again with `"raw_link": true`._

## What happens behind the scenes

- An HPKE keypair is generated (X25519 + ChaCha20-Poly1305)
- The user encrypts the secret client-side in their browser
- Only the agent's private key can decrypt it
- The encrypted payload is single-use and auto-expires
