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

function resolveChannelId(params, context) {
    const fromParams = typeof params?.channel_id === "string" ? params.channel_id.trim() : "";
    if (fromParams) return fromParams;

    const candidates = [
        context?.channel_id,
        context?.channelId,
        context?.chat_id,
        context?.chatId,
        context?.session?.channel_id,
        context?.session?.channelId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return "";
}

function resolveRuntimeChannelId(api) {
    const runtime = api?.runtime;
    const channel = runtime?.channel;
    const candidates = [
        channel?.channel_id,
        channel?.channelId,
        channel?.chat_id,
        channel?.chatId,
        channel?.current?.channel_id,
        channel?.current?.channelId,
        channel?.current?.chat_id,
        channel?.current?.chatId,
        channel?.session?.channel_id,
        channel?.session?.channelId,
        channel?.session?.chat_id,
        channel?.session?.chatId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return "";
}

async function sendViaRuntimeChannel(api, message, channelId) {
    const runtime = api?.runtime;
    const channel = runtime?.channel;
    if (!channel || typeof channel !== "object") {
        return { ok: false, attempted: [] };
    }

    const resolvedChannelId = channelId || resolveRuntimeChannelId(api);
    const attempted = [];
    const candidates = [
        { label: "runtime.channel.sendText(message)", fn: channel.sendText, args: [message] },
        { label: "runtime.channel.sendMessage(message)", fn: channel.sendMessage, args: [message] },
        { label: "runtime.channel.reply(message)", fn: channel.reply, args: [message] },
        { label: "runtime.channel.send({text})", fn: channel.send, args: [{ text: message }] },
        { label: "runtime.channel.sendMessage({text})", fn: channel.sendMessage, args: [{ text: message }] },
    ];

    if (resolvedChannelId) {
        candidates.push(
            { label: "runtime.channel.sendText(channelId,message)", fn: channel.sendText, args: [resolvedChannelId, message] },
            { label: "runtime.channel.sendMessage(channelId,message)", fn: channel.sendMessage, args: [resolvedChannelId, message] },
            {
                label: "runtime.channel.send({channelId,text})",
                fn: channel.send,
                args: [{ channelId: resolvedChannelId, text: message }],
            },
            {
                label: "runtime.channel.sendMessage({channelId,text})",
                fn: channel.sendMessage,
                args: [{ channelId: resolvedChannelId, text: message }],
            },
        );
    }

    for (const c of candidates) {
        if (typeof c.fn !== "function") continue;
        attempted.push(c.label);
        try {
            await c.fn.call(channel, ...c.args);
            return { ok: true, via: c.label };
        } catch (err) {
            console.warn(`[agent-secrets] ${c.label} failed: ${err?.message ?? String(err)}`);
        }
    }

    return { ok: false, attempted };
}

async function sendMessageToChannel(api, context, message, channelId) {
    const attempted = [];
    const targets = [
        { label: "context.sendText", owner: context, fn: context?.sendText, args: [message] },
        { label: "context.sendMessage", owner: context, fn: context?.sendMessage, args: [message] },
        { label: "context.reply", owner: context, fn: context?.reply, args: [message] },
        { label: "api.sendText", owner: api, fn: api?.sendText, args: [message] },
        { label: "api.sendMessage", owner: api, fn: api?.sendMessage, args: [message] },
    ];

    if (channelId) {
        targets.push(
            { label: "context.sendMessage(channelId,message)", owner: context, fn: context?.sendMessage, args: [channelId, message] },
            { label: "api.sendMessage(channelId,message)", owner: api, fn: api?.sendMessage, args: [channelId, message] },
            { label: "api.chatAdapter.sendMessage(channelId,message)", owner: api?.chatAdapter, fn: api?.chatAdapter?.sendMessage, args: [channelId, message] },
        );
    }

    for (const target of targets) {
        if (typeof target.fn !== "function") continue;
        attempted.push(target.label);
        try {
            await target.fn.call(target.owner, ...target.args);
            return { ok: true, via: target.label };
        } catch (err) {
            console.warn(`[agent-secrets] ${target.label} failed: ${err?.message ?? String(err)}`);
        }
    }

    return { ok: false, attempted };
}

async function sendTelegramFallback(message, channelId) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        return { ok: false, reason: "missing TELEGRAM_BOT_TOKEN" };
    }

    const chatId = channelId || process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
        return { ok: false, reason: "missing TELEGRAM_CHAT_ID/channel_id" };
    }

    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
            disable_web_page_preview: false,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        return { ok: false, reason: `telegram ${response.status}: ${body}` };
    }

    return { ok: true, via: "telegram-api-fallback" };
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
                channel_id: {
                    type: "string",
                    description: "Optional explicit chat/channel ID for outbound link delivery when runtime context does not provide send helpers.",
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
                        const channelId = resolveChannelId(params, context);
                        const routed = await sendMessageToChannel(api, context, message, channelId);
                        if (routed.ok) {
                            console.log(`[agent-secrets] Secret link delivered via ${routed.via}.`);
                            return;
                        }

                        const runtimeRouted = await sendViaRuntimeChannel(api, message, channelId);
                        if (runtimeRouted.ok) {
                            console.log(`[agent-secrets] Secret link delivered via ${runtimeRouted.via}.`);
                            return;
                        }

                        const telegram = await sendTelegramFallback(message, channelId);
                        if (telegram.ok) {
                            console.log("[agent-secrets] Secret link delivered via Telegram API fallback.");
                            return;
                        }

                        const contextKeys = Object.keys(context ?? {});
                        const apiKeys = Object.keys(api ?? {});
                        const runtimeKeys = Object.keys(api?.runtime ?? {});
                        const runtimeChannelKeys = Object.keys(api?.runtime?.channel ?? {});
                        console.error(
                            `[agent-secrets] No outbound chat transport available. attempted=${routed.attempted.join(",")} runtimeAttempted=${runtimeRouted.attempted.join(",")} telegram=${telegram.reason} contextKeys=${contextKeys.join(",")} apiKeys=${apiKeys.join(",")} runtimeKeys=${runtimeKeys.join(",")} runtimeChannelKeys=${runtimeChannelKeys.join(",")}`
                        );
                        throw new Error(
                            "Could not deliver secure link to chat channel. Configure plugin chat API (sendText/sendMessage/reply), or set TELEGRAM_BOT_TOKEN and channel_id/TELEGRAM_CHAT_ID."
                        );
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
