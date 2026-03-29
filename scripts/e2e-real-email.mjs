#!/usr/bin/env node

/**
 * Fully Automated E2E test with real email delivery using Mail.tm.
 * 
 * 1. Discovers a domain on Mail.tm
 * 2. Creates a unique temporary account
 * 3. Logs in to retrieve a JWT token for secure inbox access
 * 4. Starts the SPS server locally with database connection
 * 5. Registers a user with the Mail.tm address
 * 6. Polls Mail.tm until the verification email is received
 * 7. Extracts the verification token from the email body
 * 8. Verifies the user's email via the API
 * 9. Reports success or failure
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { buildApp } from "../packages/sps-server/dist/index.js";
import { createDbPool } from "../packages/sps-server/dist/db/index.js";
import pg from "pg"; // For creating isolated schemas

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env from Packages/sps-server/.env.test
config({ path: resolve(__dirname, "../packages/sps-server/.env.test") });

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

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── Mail.tm API ──
const MAILTM_API_URL = "https://api.mail.tm";

async function mailtmRequest(path, method = "GET", body = null, token = null) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    
    const response = await fetch(`${MAILTM_API_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
    });
    
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Mail.tm API error (${response.status} ${path}): ${err}`);
    }
    
    return await response.json();
}

// ── Main ──
async function run() {
    console.log(`${BOLD}═══════════════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}  🧪 blindpass — Robust Automated Real-Email E2E${RESET}`);
    console.log(`${BOLD}═══════════════════════════════════════════════════════${RESET}\n`);

    if (!process.env.RESEND_API_KEY) {
        console.error(`${RED}${BOLD}Error:${RESET} RESEND_API_KEY is not set in packages/sps-server/.env.test`);
        process.exit(1);
    }
    
    if (!process.env.SPS_EMAIL_FROM) {
        console.error(`${RED}${BOLD}Error:${RESET} SPS_EMAIL_FROM is not set in packages/sps-server/.env.test`);
        process.exit(1);
    }

    let app = null;
    let pool = null;
    let adminPool = null;
    let schemaName = null;

    try {
        // 1. Domain Discovery
        log("SETUP", "Discovering available Mail.tm domains...");
        const domains = await mailtmRequest("/domains");
        const domain = domains["hydra:member"][0]?.domain;
        if (!domain) throw new Error("No Mail.tm domains available.");
        log("SETUP", `Using domain: ${CYAN}${domain}${RESET}`);

        // 2. Account Creation
        const mailboxUser = `test-${Math.random().toString(36).substring(2, 10)}`;
        const mailboxPassword = `Pass!${Math.random().toString(36).substring(2, 10)}`;
        const mailboxAddress = `${mailboxUser}@${domain}`;
        
        log("SETUP", `Creating isolated account: ${CYAN}${mailboxAddress}${RESET}...`);
        await mailtmRequest("/accounts", "POST", {
            address: mailboxAddress,
            password: mailboxPassword
        });

        // 3. Login to get JWT Token
        log("SETUP", "Authenticating with Mail.tm for secure inbox access...");
        const { token: inboxToken } = await mailtmRequest("/token", "POST", {
            address: mailboxAddress,
            password: mailboxPassword
        });

        // 4. Start Server with Isolated Schema
        log("SERVER", "Creating isolated database schema...");
        const dbUrl = process.env.DATABASE_URL || "postgresql://blindpass:localdev@localhost:5433/blindpass";
        
        adminPool = new pg.Pool({ connectionString: dbUrl, max: 1 });
        schemaName = `e2e_${Math.random().toString(16).slice(2, 10)}`;
        await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
        
        log("SERVER", `Schema ${CYAN}${schemaName}${RESET} created. Starting server...`);
        const isolatedDbUrl = new URL(dbUrl);
        isolatedDbUrl.searchParams.set("options", `-c search_path=${schemaName}`);

        pool = createDbPool({ 
            connectionString: isolatedDbUrl.toString(),
            max: 1 
        });

        app = await buildApp({
            db: pool,
            runMigrations: true,
            useInMemoryStore: true,
            hmacSecret: "e2e-mailtm-hmac-secret",
            hostedMode: true,
        });
        
        // Ensure we don't mock email during THIS run
        delete process.env.SPS_EMAIL_MOCK; 

        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const baseUrl = address;
        log("SERVER", `Server listening at ${CYAN}${baseUrl}${RESET}`);

        // 5. Register
        log("API", `Registering user ${CYAN}${mailboxAddress}${RESET} via SPS API...`);
        const registerResponse = await fetch(`${baseUrl}/api/v2/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: mailboxAddress,
                password: "Password123!",
                workspace_slug: `space-${Date.now()}`,
                display_name: "Robust E2E Test Space",
                cf_turnstile_response: "mock-token" 
            })
        });

        if (!registerResponse.ok) {
            const error = await registerResponse.json();
            throw new Error(`Registration failed (${registerResponse.status}): ${JSON.stringify(error)}`);
        }
        log("API", `${GREEN}Registration successful.${RESET}`);

        // 6. Wait & Poll for email
        log("EMAIL", `Waiting for verification email from Resend (sending to ${mailboxAddress})...`);
        let emailId = null;
        const maxAttempts = 20; // Try for a while, with backoff
        let waitMs = 5000;
        
        for (let i = 0; i < maxAttempts; i++) {
            const data = await mailtmRequest("/messages", "GET", null, inboxToken);
            const found = data["hydra:member"]?.find(m => m.subject.includes("Verify your BlindPass email"));
            if (found) {
                emailId = found.id;
                log("EMAIL", `${GREEN}Verification email received!${RESET}`);
                break;
            }
            log("EMAIL", `Polling inbox... (${i + 1}/${maxAttempts}) [Waiting ${waitMs/1000}s]`);
            await sleep(waitMs);
            waitMs = Math.min(waitMs + 2000, 15000); // Progressive backoff up to 15s
        }

        if (!emailId) {
            throw new Error("Timed out waiting for verification email. Verify that your Resend domain is authorized to send to external domains.");
        }

        // 7. Read Message and Extract Token
        log("EMAIL", "Extracting verification token from message content...");
        const message = await mailtmRequest(`/messages/${emailId}`, "GET", null, inboxToken);
        const html = message.html?.[0] || message.text || "";
        
        // Token is in the URL: /verify-email/<token>
        const tokenMatch = html.match(/\/verify-email\/([a-zA-Z0-9_\-\.]+)/);
        if (!tokenMatch?.[1]) {
            throw new Error(`Could not find verification token in email body.`);
        }
        
        const token = tokenMatch[1].split(/["'<>]/)[0]; // Clean up if followed by quotes
        log("EMAIL", `${GREEN}Extracted token:${RESET} ${DIM}${token}${RESET}`);

        // 8. Verify
        log("API", "Completing email verification flow...");
        const verifyResponse = await fetch(`${baseUrl}/api/v2/auth/verify-email/${token}`);

        if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(`Verification failed (${verifyResponse.status}): ${JSON.stringify(error)}`);
        }
        log("API", `${GREEN}Verification successful!${RESET}`);

        const result = await verifyResponse.json();
        log("RESULT", `Final User Status: ${GREEN}${BOLD}${JSON.stringify(result, null, 2)}${RESET}`);

        console.log(`\n${GREEN}${BOLD}✅ ROBUST E2E FLOW COMPLETED SUCCESSFULLY${RESET}\n`);

    } finally {
        if (app) {
            log("CLEANUP", "Stopping server...");
            await app.close();
        }
        if (pool) {
            log("CLEANUP", "Closing database connection pool...");
            await pool.end();
        }
        if (adminPool && schemaName) {
            log("CLEANUP", `Dropping isolated schema ${CYAN}${schemaName}${RESET}...`);
            try {
                await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            } catch (err) {
                log("CLEANUP", `${RED}Failed to drop schema: ${err.message}${RESET}`);
            }
            await adminPool.end();
        }
    }
}

run().catch((err) => {
    console.error(`\n${RED}${BOLD}E2E test failed:${RESET}`, err.message ?? err);
    process.exit(1);
});
