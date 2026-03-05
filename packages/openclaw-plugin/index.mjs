/**
 * OpenClaw Plugin: agent-secrets
 *
 * Registers a `request_secret` tool that enables the agent to securely
 * request secrets from the user via an encrypted browser link.
 *
 * The user receives a Telegram/WhatsApp/etc. message with a link and
 * confirmation code. They click the link, verify the code, enter their
 * secret, and it's HPKE-encrypted client-side before submission.
 * The agent retrieves and decrypts it — the secret never touches
 * the server in plaintext.
 */

import { requestSecretFlow, cleanup } from "./sps-bridge.mjs";

const SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const _inMemorySecrets = new Map();

function disposeBuffer(value) {
    if (Buffer.isBuffer(value)) {
        value.fill(0);
    }
}

function setInMemorySecret(name, value) {
    const existing = _inMemorySecrets.get(name);
    if (existing) {
        disposeBuffer(existing);
    }
    _inMemorySecrets.set(name, Buffer.from(value));
}

function disposeAllInMemorySecrets() {
    for (const value of _inMemorySecrets.values()) {
        disposeBuffer(value);
    }
    _inMemorySecrets.clear();
}

async function persistSecret(api, context, name, value) {
    const targets = [
        { owner: context, fn: context?.setSecret },
        { owner: context, fn: context?.storeSecret },
        { owner: api, fn: api?.setSecret },
        { owner: api, fn: api?.storeSecret },
    ];

    for (const target of targets) {
        if (typeof target.fn === "function") {
            await target.fn.call(target.owner, name, Buffer.from(value));
            return "runtime";
        }
    }

    setInMemorySecret(name, value);
    return "plugin";
}

function normalizeSecretName(value) {
    if (value == null) return "default";
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!SECRET_NAME_PATTERN.test(trimmed)) return null;
    return trimmed;
}

export function getStoredSecret(name = "default") {
    const value = _inMemorySecrets.get(name);
    return value ? Buffer.from(value) : null;
}

export function disposeStoredSecret(name = "default") {
    const value = _inMemorySecrets.get(name);
    if (value) {
        disposeBuffer(value);
        _inMemorySecrets.delete(name);
    }
}

export default function register(api, runtime = {}) {
    const runRequestSecretFlow = runtime.requestSecretFlowFn ?? requestSecretFlow;
    const runCleanup = runtime.cleanupFn ?? cleanup;

    api.registerTool({
        name: "request_secret",
        description: [
            "Securely request a secret (API key, password, token, SSH key, etc.) from the user.",
            "This sends the user a secure link where they can enter the secret.",
            "The secret is encrypted client-side and never visible to the server.",
            "IMPORTANT: NEVER ask the user to paste secrets directly in chat. Always use this tool.",
            "The secret is stored in secure runtime memory and never returned in tool output.",
        ].join(" "),
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "Human-readable description of what the secret is for, e.g. 'GitHub deploy token for CI/CD pipeline'",
                },
                secret_name: {
                    type: "string",
                    description: "Optional key for where the runtime should store this secret (1-64 chars: letters, numbers, ., _, -). Defaults to 'default'.",
                },
            },
            required: ["description"],
        },

        async execute(_id, params, context) {
            const description = params.description?.trim();
            if (!description) {
                return {
                    content: [{ type: "text", text: "Error: description is required for request_secret." }],
                };
            }

            const secretName = normalizeSecretName(params.secret_name);
            if (secretName == null) {
                return {
                    content: [{
                        type: "text",
                        text: "Error: secret_name must match [A-Za-z0-9._-] and be 1-64 characters.",
                    }],
                };
            }

            try {
                const spsBaseUrl = process.env.SPS_BASE_URL ?? "http://localhost:3100";

                const secret = await runRequestSecretFlow({
                    description,
                    spsBaseUrl,
                    onSecretLink: async (secretUrl, confirmationCode) => {
                        // Send the link to the user via the current chat channel.
                        // context.sendText is the OpenClaw outbound — it routes to
                        // whichever channel (Telegram, WhatsApp, etc.) the conversation
                        // is happening on.
                        const message = [
                            "🔐 **Secure secret requested**",
                            "",
                            `**Purpose:** ${description}`,
                            `**Confirmation code:** \`${confirmationCode}\``,
                            "",
                            `👉 [Open secure link](${secretUrl})`,
                            "",
                            "_Verify the confirmation code matches before entering your secret._",
                            "_The link expires in 3 minutes._",
                        ].join("\n");

                        if (context?.sendText) {
                            await context.sendText(message);
                        } else if (api.sendText) {
                            await api.sendText(message);
                        } else if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
                            // Guaranteed outbound method for Telegram
                            const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
                            const response = await fetch(url, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                    chat_id: process.env.TELEGRAM_CHAT_ID,
                                    text: message,
                                    parse_mode: "Markdown",
                                    disable_web_page_preview: false,
                                }),
                            });
                            if (!response.ok) {
                                const body = await response.text();
                                console.error(`[agent-secrets] Telegram API error (${response.status}): ${body}`);
                                console.log(`[agent-secrets] Fallback secret link:\n${message}`);
                            } else {
                                console.log(`[agent-secrets] Secret link delivered via Telegram API fallback.`);
                            }
                        } else {
                            // Fallback: log it (useful for testing without a real channel)
                            console.log(`[agent-secrets] Secret link for user:\n${message}`);
                        }
                    },
                });

                let storedIn = "plugin";
                try {
                    storedIn = await persistSecret(api, context, secretName, secret);
                } finally {
                    disposeBuffer(secret);
                }

                return {
                    content: [{
                        type: "text",
                        text: [
                            "Secret received and stored securely in memory.",
                            `secret_name: ${secretName}`,
                            `storage: ${storedIn}`,
                            "Continue the task without asking the user to share secrets in chat.",
                        ].join("\n"),
                    }],
                };
            } catch (err) {
                const message = err?.message ?? String(err);

                if (message.includes("did not provide the secret in time")) {
                    return {
                        content: [{
                            type: "text",
                            text: "The user did not provide the secret within the time limit. Ask the user if they still want to proceed, and if so, call request_secret again.",
                        }],
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text: `Failed to retrieve secret: ${message}`,
                    }],
                };
            }
        },
    });

    // Cleanup temp files on gateway shutdown
    if (api.registerHook) {
        api.registerHook(
            "shutdown",
            async () => {
                await runCleanup();
            },
            {
                name: "agent-secrets.cleanup",
                description: "Cleanup temporary gateway identity files",
            },
        );
    }

    if (api.registerHook) {
        api.registerHook(
            "shutdown",
            async () => {
                disposeAllInMemorySecrets();
            },
            {
                name: "agent-secrets.dispose-secrets",
                description: "Zero and dispose in-memory secret buffers",
            },
        );
    }
}
