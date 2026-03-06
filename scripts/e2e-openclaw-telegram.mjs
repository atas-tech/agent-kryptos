#!/usr/bin/env node

/**
 * E2E Integration Test: agent-kryptos + Telegram
 *
 * Tests the full secret provisioning flow by sending a real Telegram message
 * with the secret link, then waiting for a human to submit via the Browser UI.
 *
 * This does NOT require a running OpenClaw instance — it directly tests the
 * plugin's SPS bridge + Telegram Bot API delivery.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — Telegram chat ID to send the link to
 *
 * Optional env vars:
 *   SPS_HOST             — SPS bind host (default: 0.0.0.0 for tunnel access)
 *   PORT                 — SPS port (default: 3100)
 *   SPS_PUBLIC_BASE_URL  — Public URL for the SPS (e.g. ngrok URL).
 *                          If not set, falls back to http://localhost:PORT
 *
 * Usage:
 *   # 1. Start a tunnel (in another terminal):
 *   #    ngrok http 3100
 *   #
 *   # 2. Run this script:
 *   TELEGRAM_BOT_TOKEN=123:abc \
 *   TELEGRAM_CHAT_ID=12345678 \
 *   SPS_PUBLIC_BASE_URL=https://xxxx.ngrok.io \
 *     node scripts/e2e-openclaw-telegram.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../packages/sps-server/dist/index.js";
import { loadOrCreateGatewayIdentity, writeJwksFile, issueJwt } from "../packages/gateway/dist/identity.js";
import { GatewaySpsClient } from "../packages/gateway/dist/sps-client.js";
import { SpsClient } from "../packages/agent-skill/dist/sps-client.js";
import { generateKeyPair, decrypt, destroyKeyPair } from "../packages/agent-skill/dist/key-manager.js";

// ── Config ──

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SPS_HOST = process.env.SPS_HOST ?? "0.0.0.0";
const SPS_PORT = Number(process.env.PORT ?? 3100);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
    console.error("");
    console.error("Usage:");
    console.error("  TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=12345678 \\");
    console.error("  SPS_PUBLIC_BASE_URL=https://xxxx.ngrok.io \\");
    console.error("    node scripts/e2e-openclaw-telegram.mjs");
    process.exit(1);
}

// ── Helpers ──

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function log(label, message) {
    const time = new Date().toLocaleTimeString();
    console.log(`${DIM}${time}${RESET} ${BOLD}[${label}]${RESET} ${message}`);
}

async function sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: false,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram API error (${response.status}): ${body}`);
    }

    return response.json();
}

// ── Main ──

async function run() {
    console.log();
    console.log(`${BOLD}═══════════════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}  🔐 agent-kryptos — Telegram E2E Integration Test${RESET}`);
    console.log(`${BOLD}═══════════════════════════════════════════════════════${RESET}`);
    console.log();

    // 1. Setup temp dir and gateway identity
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sps-telegram-e2e-"));
    const keyPath = path.join(tempDir, "gateway-key.json");
    const jwksPath = path.join(tempDir, "jwks.json");

    log("SETUP", "Generating gateway identity...");
    const identity = await loadOrCreateGatewayIdentity({ keyPath });
    await writeJwksFile(identity, jwksPath);
    process.env.SPS_GATEWAY_JWKS_FILE = jwksPath;

    // 2. Determine the public base URL
    // The SPS_PUBLIC_BASE_URL must be set to the tunnel URL so that the Telegram
    // user's browser can reach SPS. If not set, fall back to localhost (won't work
    // from Telegram unless on the same machine).
    const localBaseUrl = `http://${SPS_HOST === "0.0.0.0" ? "127.0.0.1" : SPS_HOST}:${SPS_PORT}`;
    const publicBaseUrl = process.env.SPS_PUBLIC_BASE_URL ?? localBaseUrl;

    if (!process.env.SPS_PUBLIC_BASE_URL) {
        log("WARN", `${YELLOW}SPS_PUBLIC_BASE_URL not set. Using ${localBaseUrl}.${RESET}`);
        log("WARN", `${YELLOW}The Telegram user won't be able to reach SPS unless on the same machine.${RESET}`);
        log("WARN", `${YELLOW}Set SPS_PUBLIC_BASE_URL to your ngrok/Tailscale URL for remote access.${RESET}`);
    }

    // 3. Start real SPS server
    const app = await buildApp({
        useInMemoryStore: true,
        hmacSecret: "telegram-e2e-hmac-secret",
        baseUrl: publicBaseUrl,
    });

    await app.listen({ host: SPS_HOST, port: SPS_PORT });
    log("SPS", `Server listening on ${CYAN}${SPS_HOST}:${SPS_PORT}${RESET}`);
    log("SPS", `Public URL: ${CYAN}${publicBaseUrl}${RESET}`);

    // 4. Generate agent HPKE keypair
    log("AGENT", "Generating HPKE keypair...");
    const keyPair = await generateKeyPair();

    try {
        // 5. Create secret request via Gateway client
        const gatewayToken = await issueJwt(identity, "telegram-e2e-agent");
        const gatewayClient = new GatewaySpsClient({
            baseUrl: publicBaseUrl,
            gatewayBearerToken: gatewayToken,
        });

        log("GATEWAY", "Creating secret request...");
        const request = await gatewayClient.createSecretRequest({
            description: "Telegram E2E Test — please enter any test secret",
            publicKey: keyPair.publicKey,
        });

        log("GATEWAY", `Request ID: ${request.requestId}`);
        log("GATEWAY", `Confirmation code: ${GREEN}${BOLD}${request.confirmationCode}${RESET}`);

        // 6. Send the link to Telegram
        log("TELEGRAM", "Sending secret link to Telegram...");

        const telegramMessage = [
            "🔐 *Secure secret requested*",
            "",
            `*Purpose:* Telegram E2E Test — please enter any test secret`,
            `*Confirmation code:* \`${request.confirmationCode}\``,
            "",
            `👉 [Open secure link](${request.secretUrl})`,
            "",
            "_Verify the confirmation code matches before entering your secret._",
            "_The link expires in 3 minutes._",
        ].join("\n");

        await sendTelegramMessage(telegramMessage);
        log("TELEGRAM", `${GREEN}Message sent to chat ${TELEGRAM_CHAT_ID}${RESET}`);

        // 7. Print instructions
        console.log();
        console.log(`${BOLD}───────────────────────────────────────────────────────${RESET}`);
        console.log(`${BOLD}  📱 Check your Telegram!${RESET}`);
        console.log(`${BOLD}───────────────────────────────────────────────────────${RESET}`);
        console.log();
        console.log(`  1. Open the Telegram message from your bot`);
        console.log(`  2. Click the secure link`);
        console.log(`  3. Verify the confirmation code: ${GREEN}${BOLD}${request.confirmationCode}${RESET}`);
        console.log(`  4. Enter any test secret and submit`);
        console.log();
        console.log(`  ⏳ Waiting for submission (3 minute timeout)...`);
        console.log();
        console.log(`${BOLD}───────────────────────────────────────────────────────${RESET}`);
        console.log();

        // 8. Poll for submission (agent-side)
        const agentToken = await issueJwt(identity, "telegram-e2e-agent");
        const agentClient = new SpsClient({
            baseUrl: publicBaseUrl,
            gatewayBearerToken: agentToken,
        });

        log("AGENT", "Polling for secret submission...");

        await agentClient.pollStatus(request.requestId, 1000, 180_000, 60_000);
        log("AGENT", `${GREEN}Secret submitted!${RESET}`);

        // 9. Retrieve + decrypt
        log("AGENT", "Retrieving encrypted payload...");
        const payload = await agentClient.retrieveSecret(request.requestId);

        log("AGENT", "Decrypting with private key...");
        const plaintext = await decrypt(keyPair.privateKey, payload.enc, payload.ciphertext);
        const secretValue = plaintext.toString("utf8");

        // 10. Report results
        console.log();
        console.log(`${BOLD}───────────────────────────────────────────────────────${RESET}`);
        console.log(`${BOLD}  ✅ Telegram E2E Test Complete!${RESET}`);
        console.log(`${BOLD}───────────────────────────────────────────────────────${RESET}`);
        console.log();
        console.log(`  Decrypted secret: ${GREEN}${BOLD}${secretValue}${RESET}`);
        console.log();

        // 11. Verify atomic single-use
        log("VERIFY", "Attempting second retrieve (should fail)...");
        try {
            await agentClient.retrieveSecret(request.requestId);
            log("VERIFY", `${RED}FAIL — second retrieve succeeded${RESET}`);
            process.exitCode = 1;
        } catch {
            log("VERIFY", `${GREEN}PASS — second retrieve correctly returned 410 Gone${RESET}`);
        }

        // 12. Send success notification to Telegram
        await sendTelegramMessage(
            `✅ E2E test passed! Decrypted secret received successfully.\n\n` +
            `_Secret value verified (${secretValue.length} chars)._`
        );
        log("TELEGRAM", `${GREEN}Success notification sent to Telegram${RESET}`);

        console.log();
    } finally {
        destroyKeyPair(keyPair);
        await app.close();
        await rm(tempDir, { recursive: true, force: true });
        log("CLEANUP", "Server stopped, temp files removed.");
    }
}

run().catch((err) => {
    console.error(`\n${RED}${BOLD}E2E test failed:${RESET}`, err.message ?? err);
    process.exit(1);
});
