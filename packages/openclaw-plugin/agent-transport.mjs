export const EXCHANGE_FULFILLMENT_ENVELOPE_KIND = "blindpass.exchange-fulfillment.v1";

function lookupInMapLike(source, key) {
    if (!source || !key) {
        return null;
    }
    if (source instanceof Map) {
        const value = source.get(key);
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }
    if (typeof source === "object") {
        const value = source[key];
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }
    return null;
}

function parseAgentTargetMap(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function lookupSessionRecord(record) {
    if (!record || typeof record !== "object") {
        return null;
    }

    const candidates = [
        record.target,
        record.sessionTarget,
        record.sessionKey,
        record.session_id,
        record.sessionId,
        record.id,
        record.key,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return null;
}

async function resolveViaFunction(owner, fn, agentId) {
    if (typeof fn !== "function") {
        return null;
    }

    const value = await fn.call(owner, agentId);
    return typeof value === "string" && value.trim() ? value.trim() : lookupSessionRecord(value);
}

async function resolveViaSessionDirectory(api, agentId) {
    const direct = await resolveViaFunction(api, api?.resolveAgentTarget, agentId)
        || await resolveViaFunction(api?.runtime, api?.runtime?.resolveAgentTarget, agentId)
        || await resolveViaFunction(api?.agentDirectory, api?.agentDirectory?.resolveTarget, agentId)
        || await resolveViaFunction(api?.runtime?.agentDirectory, api?.runtime?.agentDirectory?.resolveTarget, agentId)
        || await resolveViaFunction(api?.runtime?.sessions, api?.runtime?.sessions?.resolveTarget, agentId)
        || await resolveViaFunction(api?.runtime?.sessions, api?.runtime?.sessions?.getTarget, agentId);
    if (direct) {
        return direct;
    }

    const byAgentIdSources = [
        api?.agentTargetMap,
        api?.runtime?.agentTargetMap,
        api?.runtime?.sessions?.byAgentId,
        api?.runtime?.sessions?.targetsByAgentId,
        api?.runtime?.agentDirectory?.targetsByAgentId,
    ];

    for (const source of byAgentIdSources) {
        const mapped = lookupInMapLike(source, agentId);
        if (mapped) {
            return mapped;
        }

        if (source instanceof Map) {
            const record = source.get(agentId);
            const resolved = lookupSessionRecord(record);
            if (resolved) {
                return resolved;
            }
        } else if (source && typeof source === "object") {
            const resolved = lookupSessionRecord(source[agentId]);
            if (resolved) {
                return resolved;
            }
        }
    }

    const listFns = [
        { owner: api?.runtime?.sessions, fn: api?.runtime?.sessions?.list },
        { owner: api?.runtime?.sessions, fn: api?.runtime?.sessions?.listSessions },
        { owner: api?.runtime?.agentDirectory, fn: api?.runtime?.agentDirectory?.list },
        { owner: api?.runtime?.agentDirectory, fn: api?.runtime?.agentDirectory?.listAgents },
    ];

    for (const candidate of listFns) {
        if (typeof candidate.fn !== "function") continue;
        const records = await candidate.fn.call(candidate.owner);
        if (!Array.isArray(records)) continue;
        const match = records.find((record) => {
            if (!record || typeof record !== "object") {
                return false;
            }
            return record.agentId === agentId || record.agent_id === agentId || record.id === agentId;
        });
        const resolved = lookupSessionRecord(match);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

export function buildExchangeDeliveryMessage(envelope) {
    const payload = {
        kind: EXCHANGE_FULFILLMENT_ENVELOPE_KIND,
        exchange_id: envelope.exchangeId,
        requester_id: envelope.requesterId ?? null,
        fulfiller_id: envelope.fulfillerId,
        secret_name: envelope.secretName,
        purpose: envelope.purpose,
        tool_call: {
            name: "fulfill_secret_exchange",
            arguments: {
                fulfillment_token: envelope.fulfillmentToken,
            },
        },
    };

    return [
        "BlindPass secret exchange request.",
        "Invoke `fulfill_secret_exchange` with the payload below.",
        "```json",
        JSON.stringify(payload, null, 2),
        "```",
    ].join("\n");
}

export async function resolveOpenClawAgentTarget(api, envelope, options = {}) {
    const fulfillerId = typeof envelope?.fulfillerId === "string" ? envelope.fulfillerId.trim() : "";
    if (!fulfillerId) {
        return null;
    }

    if (typeof options.resolveTarget === "function") {
        const resolved = await options.resolveTarget(envelope);
        if (typeof resolved === "string" && resolved.trim()) {
            return resolved.trim();
        }
    }

    const mapSources = [
        options.targetMap,
        parseAgentTargetMap(process.env.OPENCLAW_AGENT_TARGETS_JSON),
    ];

    for (const source of mapSources) {
        const mapped = lookupInMapLike(source, fulfillerId);
        if (mapped) {
            return mapped;
        }
    }

    const resolvedFromRuntime = await resolveViaSessionDirectory(api, fulfillerId);
    if (resolvedFromRuntime) {
        return resolvedFromRuntime;
    }

    if (options.directTargetFallback !== false) {
        return fulfillerId;
    }

    return null;
}

export async function deliverExchangeToAgent(api, params) {
    const { target, envelope } = params;
    const message = params.message ?? buildExchangeDeliveryMessage(envelope);
    const attempted = [];

    const candidates = [
        { label: "api.sendToSession(target,message)", owner: api, fn: api?.sendToSession, args: [target, message] },
        { label: "api.runtime.sendToSession(target,message)", owner: api?.runtime, fn: api?.runtime?.sendToSession, args: [target, message] },
        { label: "api.agentToAgent.send({target,message})", owner: api?.agentToAgent, fn: api?.agentToAgent?.send, args: [{ target, message }] },
        { label: "api.runtime.agentToAgent.send({target,message})", owner: api?.runtime?.agentToAgent, fn: api?.runtime?.agentToAgent?.send, args: [{ target, message }] },
        { label: "api.runtime.sessions.send(target,message)", owner: api?.runtime?.sessions, fn: api?.runtime?.sessions?.send, args: [target, message] },
        { label: "api.runtime.channel.sendMessage(target,message)", owner: api?.runtime?.channel, fn: api?.runtime?.channel?.sendMessage, args: [target, message] },
    ];

    for (const candidate of candidates) {
        if (typeof candidate.fn !== "function") continue;
        attempted.push(candidate.label);
        try {
            await candidate.fn.call(candidate.owner, ...candidate.args);
            return { ok: true, via: candidate.label };
        } catch (err) {
            console.warn(`[blindpass] ${candidate.label} failed: ${err?.message ?? String(err)}`);
        }
    }

    return { ok: false, attempted };
}

export function createOpenClawAgentTransport(api, options = {}) {
    const formatMessage = options.formatMessage ?? buildExchangeDeliveryMessage;

    return {
        async deliverFulfillmentToken(envelope) {
            const target = await resolveOpenClawAgentTarget(api, envelope, options);
            if (!target || typeof target !== "string") {
                throw new Error(`OpenClaw transport could not resolve a target session for fulfiller '${envelope.fulfillerId}'.`);
            }

            const result = await deliverExchangeToAgent(api, {
                target,
                envelope,
                message: formatMessage(envelope),
            });
            if (!result.ok) {
                throw new Error(`No OpenClaw agent transport succeeded. attempted=${result.attempted.join(",") || "(none)"}`);
            }
        },
    };
}
