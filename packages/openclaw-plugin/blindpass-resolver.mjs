/**
 * BlindPass OpenClaw exec-provider resolver entrypoint.
 *
 * Phase 1 scaffolding: this file exists so build output can expose a stable
 * resolver CLI target (`blindpass-resolver.mjs`) while exec-provider protocol
 * support is implemented in Phase 3.
 */

console.error("[blindpass] blindpass-resolver is not implemented yet. Follow docs/plugins/openclaw-capability-extension.md (Phase 3).");
process.exitCode = 1;
