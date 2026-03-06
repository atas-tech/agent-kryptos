---
name: agent-secrets
description: Securely request credentials and API keys from the user via encrypted link
---

# Secure Secret Provisioning

When you need any kind of secret, credential, API key, password, token, SSH key, or other sensitive value from the user, you **MUST** use the `request_secret` tool. 

## Rules

1. **NEVER** ask the user to paste secrets directly in chat — this is insecure
2. **ALWAYS** use `request_secret` with a clear description of what the secret is for
3. **WAIT** for the tool to return before proceeding — it blocks until the user submits
4. **DO NOT** repeat or echo the secret value in chat after receiving it
5. Use the secret only for its intended purpose (e.g., in an API call, config file, etc.)

## Example usage

When you need an API key:
- Call `request_secret` with description: "GitHub personal access token for deploying to production"
- The user will receive a secure link in their chat
- They click the link, verify the confirmation code, and enter the secret
- The tool returns the decrypted value for you to use

_Note: If a user mentions that they cannot click the link or that the link is missing/broken (which happens in some chat UIs that strip Markdown), you should call `request_secret` again with `"raw_link": true` to provide a plaintext URL._

## What happens behind the scenes

- An HPKE keypair is generated (X25519 + ChaCha20-Poly1305)
- The user encrypts the secret client-side in their browser
- Only the agent's private key can decrypt it
- The encrypted payload is single-use and auto-expires
