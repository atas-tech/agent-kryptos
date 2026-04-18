# BlindPass (MCP) Instructions For Claude Code

Use the `blindpass` MCP server for secret provisioning and exchange.

## Safety Rules
- Never ask users to paste secrets in chat.
- Use `request_secret` for human-provided secrets.
- Use `request_secret_exchange` for agent-to-agent secret fulfillment.
- Treat all tool outputs as sensitive metadata; do not echo secret values unless deployment policy explicitly allows it.

## Tool Contracts
- `request_secret`:
  - Requires `description`.
  - If `persist=true`, `secret_name` is required.
  - `persist=false` is interactive runtime-only mode.
- `request_secret_exchange`:
  - Requires `purpose`, `fulfiller_id`.
  - If `persist=true`, `secret_name` is required.
- `fulfill_secret_exchange`:
  - Requires `fulfillment_token`.
- `store_secret`:
  - Only available when `BLINDPASS_ENABLE_STORE_TOOL=true`.
  - Never echoes plaintext value in output.
- `list_secrets`, `delete_secret`, `confirm_delete_secret`:
  - `delete_secret` is two-step and returns a short-lived confirmation token.

## Typical MCP config
```json
{
  "mcpServers": {
    "blindpass": {
      "command": "node",
      "args": ["~/.claude/skills/blindpass/dist/mcp-server.mjs"],
      "env": {
        "SPS_BASE_URL": "https://sps.blindpass.dev",
        "BLINDPASS_API_KEY": "your-api-key"
      }
    }
  }
}
```
