/**
 * OpenClaw Plugin: blindpass
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

import { buildExchangeDeliveryMessage, createOpenClawAgentTransport, resolveOpenClawAgentTarget } from "./agent-transport.mjs";
import { fulfillExchangeFlow, requestExchangeFlow, requestSecretFlow, cleanup } from "./sps-bridge.mjs";
import { spawn } from "node:child_process";

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

function cloneSecretValue(value) {
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (typeof value === "string") {
        return Buffer.from(value, "utf8");
    }
    return null;
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
            setInMemorySecret(name, value);
            return "runtime";
        }
    }

    setInMemorySecret(name, value);
    return "plugin";
}

async function resolveStoredSecret(api, context, name) {
    const targets = [
        { owner: context, fn: context?.getSecret, args: [name] },
        { owner: context, fn: context?.readSecret, args: [name] },
        { owner: api, fn: api?.getSecret, args: [name] },
        { owner: api, fn: api?.readSecret, args: [name] },
    ];

    for (const target of targets) {
        if (typeof target.fn !== "function") continue;
        try {
            const value = await target.fn.call(target.owner, ...target.args);
            const normalized = cloneSecretValue(value);
            if (normalized) {
                return normalized;
            }
        } catch (err) {
            console.warn(`[blindpass] Secret lookup via runtime failed: ${err?.message ?? String(err)}`);
        }
    }

    return getStoredSecret(name);
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

function resolveChannelName(params, context, channelId) {
    const fromParams = typeof params?.channel === "string" ? params.channel.trim() : "";
    if (fromParams) return fromParams;

    const fromContext = [
        context?.channel,
        context?.channel_name,
        context?.session?.channel,
        context?.session?.channel_name,
    ];
    for (const candidate of fromContext) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    if (typeof channelId === "string" && channelId.includes(":")) {
        return channelId.split(":")[0].trim();
    }

    const fromEnv = process.env.OPENCLAW_MESSAGE_CHANNEL?.trim();
    if (fromEnv) return fromEnv;

    return "";
}

function resolveMessageTarget(params, context, channelId) {
    const explicit = [
        params?.target,
        params?.chat_id,
        context?.target,
        context?.chat_id,
        context?.chatId,
        process.env.OPENCLAW_MESSAGE_TARGET,
    ];
    for (const candidate of explicit) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    if (typeof channelId === "string" && channelId.trim()) {
        const trimmed = channelId.trim();
        if (trimmed.includes(":")) {
            return trimmed.split(":").slice(1).join(":").trim();
        }
        return trimmed;
    }

    return "";
}

function resolveConfiguredAgentId() {
    return process.env.BLINDPASS_AGENT_ID?.trim() || process.env.OPENCLAW_AGENT_ID?.trim() || "blindpass-agent";
}

async function runExecFile(execFileFn, file, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const child = execFileFn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                child.kill("SIGKILL");
            }
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                reject(new Error(`exit=${code} stderr=${stderr.trim() || "(empty)"}`));
            }
        });
    });
}

async function sendViaOpenClawCli(params) {
    const {
        message,
        channel,
        target,
        execFileFn = spawn,
        timeoutMs = Number(process.env.OPENCLAW_CLI_TIMEOUT_MS ?? 15000),
    } = params;

    if (!target) {
        return { ok: false, reason: "missing CLI target (channel_id/chat_id/OPENCLAW_MESSAGE_TARGET)" };
    }
    if (!channel) {
        return { ok: false, reason: "missing CLI channel (params.channel/context.channel/OPENCLAW_MESSAGE_CHANNEL)" };
    }

    const args = ["message", "send", "--channel", channel, "--target", target, "--message", message];
    try {
        await runExecFile(execFileFn, "openclaw", args, timeoutMs);
        return { ok: true, via: "openclaw-cli" };
    } catch (err) {
        return { ok: false, reason: err?.message ?? String(err) };
    }
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
            console.warn(`[blindpass] ${c.label} failed: ${err?.message ?? String(err)}`);
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
            console.warn(`[blindpass] ${target.label} failed: ${err?.message ?? String(err)}`);
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

export { buildExchangeDeliveryMessage, createOpenClawAgentTransport, resolveOpenClawAgentTarget };

export default function register(api, runtime = {}) {
    const runRequestSecretFlow = runtime.requestSecretFlowFn ?? requestSecretFlow;
    const runRequestExchangeFlow = runtime.requestExchangeFlowFn ?? requestExchangeFlow;
    const runFulfillExchangeFlow = runtime.fulfillExchangeFlowFn ?? fulfillExchangeFlow;
    const runCleanup = runtime.cleanupFn ?? cleanup;
    const buildAgentTransport = runtime.createOpenClawAgentTransportFn ?? createOpenClawAgentTransport;
    const execFileFn = runtime.execFileFn ?? spawn;

    api.registerTool({
        name: "request_secret_exchange",
        description: [
            "Securely request a named secret from another authenticated agent through SPS.",
            "This uses the OpenClaw runtime transport to deliver an SPS fulfillment token to the fulfiller agent.",
            "The secret plaintext is never returned in tool output and is stored only in runtime memory.",
        ].join(" "),
        parameters: {
            type: "object",
            properties: {
                secret_name: {
                    type: "string",
                    description: "Stable logical secret identifier, e.g. 'stripe.api_key.prod'.",
                },
                purpose: {
                    type: "string",
                    description: "Short reason for the exchange, e.g. 'charge-customer-order'.",
                },
                fulfiller_id: {
                    type: "string",
                    description: "Stable agent identity expected to fulfill the exchange, e.g. 'agent:payment-bot'.",
                },
                prior_exchange_id: {
                    type: "string",
                    description: "Optional prior exchange to supersede for re-request / rotation lineage.",
                },
                reserved_timeout_ms: {
                    type: "number",
                    description: "Optional time to wait after the fulfiller reserves the exchange before failing closed.",
                },
            },
            required: ["secret_name", "purpose", "fulfiller_id"],
        },

        async execute(_id, params, context) {
            const secretName = normalizeSecretName(params.secret_name);
            if (secretName == null) {
                return {
                    content: [{
                        type: "text",
                        text: "Error: secret_name must match [A-Za-z0-9._-] and be 1-64 characters.",
                    }],
                };
            }

            const purpose = typeof params.purpose === "string" ? params.purpose.trim() : "";
            if (!purpose) {
                return {
                    content: [{ type: "text", text: "Error: purpose is required for request_secret_exchange." }],
                };
            }

            const fulfillerId = typeof params.fulfiller_id === "string" ? params.fulfiller_id.trim() : "";
            if (!fulfillerId) {
                return {
                    content: [{ type: "text", text: "Error: fulfiller_id is required for request_secret_exchange." }],
                };
            }
            const priorExchangeId = typeof params.prior_exchange_id === "string" ? params.prior_exchange_id.trim() : "";

            const reservedTimeoutMs = params.reserved_timeout_ms;
            if (reservedTimeoutMs != null && (!Number.isFinite(reservedTimeoutMs) || reservedTimeoutMs <= 0)) {
                return {
                    content: [{
                        type: "text",
                        text: "Error: reserved_timeout_ms must be a positive number when provided.",
                    }],
                };
            }

            try {
                const transport = buildAgentTransport(api, runtime.agentTransportOptions ?? {});
                const result = await runRequestExchangeFlow({
                    secretName,
                    purpose,
                    fulfillerId,
                    priorExchangeId,
                    reservedTimeoutMs,
                    spsBaseUrl: process.env.SPS_BASE_URL ?? "http://localhost:3100",
                    agentId: resolveConfiguredAgentId(),
                    transport,
                });

                let storedIn = "plugin";
                try {
                    storedIn = await persistSecret(api, context, secretName, result.secret);
                } finally {
                    disposeBuffer(result.secret);
                }

                return {
                    content: [{
                        type: "text",
                        text: [
                            "Secret exchange completed and stored securely in memory.",
                            `exchange_id: ${result.exchangeId}`,
                            `secret_name: ${secretName}`,
                            `fulfilled_by: ${result.fulfilledBy ?? fulfillerId}`,
                            `storage: ${storedIn}`,
                            "Continue the task without asking the user to share secrets in chat.",
                        ].join("\n"),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed to request secret exchange: ${err?.message ?? String(err)}`,
                    }],
                };
            }
        },
    });

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
                channel: {
                    type: "string",
                    description: "Optional channel name for CLI fallback (e.g. telegram).",
                },
                target: {
                    type: "string",
                    description: "Optional explicit target (chat id or @username) for OpenClaw CLI fallback.",
                },
                raw_link: {
                    type: "boolean",
                    description: "Optional. Set to true if the chat client does not support Markdown links properly.",
                },
                re_request: {
                    type: "boolean",
                    description: "Optional. Set to true if a previously stored secret is now missing (e.g. after restart), asking the user to re-enter it.",
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

            // Routing params are optional if the context runtime provides sendText/sendMessage helpers.
            // We defer routing failures to the actual transport loop below to allow graceful fallbacks.

            try {
                const spsBaseUrl = process.env.SPS_BASE_URL ?? "http://localhost:3100";

                const secret = await runRequestSecretFlow({
                    description,
                    spsBaseUrl,
                    agentId: resolveConfiguredAgentId(),
                    onSecretLink: async (secretUrl, confirmationCode) => {
                        console.log("[blindpass] Delivering secure link to configured channel.");

                        const useRawLink = params.raw_link === true || process.env.OPENCLAW_SECRETS_RAW_LINK === "true" || process.env.OPENCLAW_SECRETS_RAW_LINK === "1";
                        const isReRequest = params.re_request === true;

                        const messageLines = [
                            isReRequest ? "🔐 **Re-enter your secret to continue**" : "🔐 **Secure secret requested**",
                            "",
                            `**Purpose:** ${description}`,
                            `**Confirmation code:** \`${confirmationCode}\``,
                            "",
                            `👉 [Open secure link](${secretUrl})`,
                        ];

                        if (useRawLink) {
                            messageLines.push("", `Raw link: ${secretUrl}`);
                        }

                        messageLines.push(
                            "",
                            "_Verify the confirmation code matches before entering your secret._",
                            "_The link expires in 3 minutes._"
                        );

                        const message = messageLines.join("\n");
                        const channelId = resolveChannelId(params, context);
                        const channelName = resolveChannelName(params, context, channelId);
                        const target = resolveMessageTarget(params, context, channelId);

                        const routed = await sendMessageToChannel(api, context, message, channelId);
                        if (routed.ok) {
                            console.log(`[blindpass] Secret link delivered via ${routed.via}.`);
                            return;
                        }

                        const runtimeRouted = await sendViaRuntimeChannel(api, message, channelId);
                        if (runtimeRouted.ok) {
                            console.log(`[blindpass] Secret link delivered via ${runtimeRouted.via}.`);
                            return;
                        }

                        const cli = await sendViaOpenClawCli({
                            message,
                            channel: channelName,
                            target,
                            execFileFn,
                        });
                        if (cli.ok) {
                            console.log("[blindpass] Secret link delivered via OpenClaw CLI fallback.");
                            return;
                        }

                        const telegram = await sendTelegramFallback(message, channelId);
                        if (telegram.ok) {
                            console.log("[blindpass] Secret link delivered via Telegram API fallback.");
                            return;
                        }

                        const contextKeys = Object.keys(context ?? {});
                        const apiKeys = Object.keys(api ?? {});
                        const runtimeKeys = Object.keys(api?.runtime ?? {});
                        const runtimeChannelKeys = Object.keys(api?.runtime?.channel ?? {});
                        console.error(
                            `[blindpass] No outbound chat transport available. attempted=${routed.attempted.join(",")} runtimeAttempted=${runtimeRouted.attempted.join(",")} cli=${cli.reason} telegram=${telegram.reason} contextKeys=${contextKeys.join(",")} apiKeys=${apiKeys.join(",")} runtimeKeys=${runtimeKeys.join(",")} runtimeChannelKeys=${runtimeChannelKeys.join(",")} channel=${channelName} target=${target}`
                        );
                        throw new Error(
                            "Could not deliver secure link to chat channel. Configure plugin chat API (sendText/sendMessage/reply), OpenClaw CLI target/channel, or TELEGRAM_BOT_TOKEN with channel_id/TELEGRAM_CHAT_ID."
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

    api.registerTool({
        name: "fulfill_secret_exchange",
        description: [
            "Fulfill a Secret Provisioning Service agent-to-agent exchange using a secret already stored in runtime memory.",
            "Use this only for authenticated agent-to-agent exchange messages carrying a fulfillment token.",
            "This tool never returns the secret plaintext.",
        ].join(" "),
        parameters: {
            type: "object",
            properties: {
                fulfillment_token: {
                    type: "string",
                    description: "SPS-signed fulfillment token for a pending exchange request.",
                },
            },
            required: ["fulfillment_token"],
        },

        async execute(_id, params, context) {
            const fulfillmentToken = typeof params.fulfillment_token === "string" ? params.fulfillment_token.trim() : "";
            if (!fulfillmentToken) {
                return {
                    content: [{ type: "text", text: "Error: fulfillment_token is required for fulfill_secret_exchange." }],
                };
            }

            try {
                const result = await runFulfillExchangeFlow({
                    fulfillmentToken,
                    spsBaseUrl: process.env.SPS_BASE_URL ?? "http://localhost:3100",
                    agentId: resolveConfiguredAgentId(),
                    resolveSecret: async (secretName) => resolveStoredSecret(api, context, secretName),
                });

                return {
                    content: [{
                        type: "text",
                        text: [
                            "Secret exchange fulfilled successfully.",
                            `exchange_id: ${result.exchangeId}`,
                            `secret_name: ${result.secretName}`,
                            `fulfilled_by: ${result.fulfilledBy}`,
                        ].join("\n"),
                    }],
                };
            } catch (err) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed to fulfill secret exchange: ${err?.message ?? String(err)}`,
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
                name: "blindpass.cleanup",
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
                name: "blindpass.dispose-secrets",
                description: "Zero and dispose in-memory secret buffers",
            },
        );
    }
}
