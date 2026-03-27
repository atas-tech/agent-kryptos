# Agent Secret Skill

Trigger phrases: "need credentials", "request secret", "API key required".

Rules:
- Never ask for secrets in chat.
- Always use `request_secret` tool path.
- If a tool execution fails because a secret is missing (e.g., after an agent restart), call `request_secret` again with `{ "re_request": true }` to securely prompt the user to re-enter it.
- In hosted mode, use a bootstrap API key. The SDK handles JWT exchange and periodic token refresh automatically.
