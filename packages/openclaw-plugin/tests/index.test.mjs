import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import register, {
    buildExchangeDeliveryMessage,
    createOpenClawAgentTransport,
    disposeStoredSecret,
    getStoredSecret,
    resolveOpenClawAgentTarget,
} from "../index.mjs";
import { cleanup as cleanupBridge, requestSecretFlow } from "../sps-bridge.mjs";

function createMockApi() {
    const state = {
        tools: new Map(),
        hooks: [],
    };

    return {
        state,
        registerTool(tool) {
            state.tools.set(tool.name, tool);
        },
        registerHook(event, handler, meta) {
            state.hooks.push({ event, handler, meta });
        },
    };
}

function getTool(api, name) {
    const tool = api.state.tools.get(name);
    assert.ok(tool, `Tool '${name}' should be registered`);
    return tool;
}

function createMockChild(exitCode = 0, stderrText = "") {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    setImmediate(() => {
        if (stderrText) {
            child.stderr.write(stderrText);
        }
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode);
    });

    return child;
}

async function testNoPlaintextExposure() {
    const api = createMockApi();
    const outbound = [];

    register(api, {
        requestSecretFlowFn: async ({ onSecretLink }) => {
            await onSecretLink("https://secrets.example/r/abc", "BLUE-FOX-42");
            return Buffer.from("super-secret-value", "utf8");
        },
        cleanupFn: async () => { },
    });

    const result = await getTool(api, "request_secret").execute(
        "id-1",
        { description: "AWS deployment token", secret_name: "aws_token", channel_id: "telegram:111" },
        { sendText: async (message) => outbound.push(message) },
    );

    assert.equal(outbound.length, 1, "Should send one user-facing link message");

    const output = result?.content?.[0]?.text ?? "";
    assert.ok(output.includes("Secret received and stored securely in memory."));
    assert.ok(output.includes("secret_name: aws_token"));
    assert.ok(!output.includes("super-secret-value"), "Tool output must not include plaintext secret");

    const stored = getStoredSecret("aws_token");
    assert.ok(stored, "Stored secret should be available in plugin memory");
    assert.equal(stored.toString("utf8"), "super-secret-value");

    disposeStoredSecret("aws_token");
}

async function testUsesOpenClawCliFallback() {
    const api = createMockApi();
    const calls = [];

    register(api, {
        requestSecretFlowFn: async ({ onSecretLink }) => {
            await onSecretLink("https://secrets.example/r/abc", "BLUE-FOX-42");
            return Buffer.from("cli-secret", "utf8");
        },
        cleanupFn: async () => { },
        execFileFn: (file, args) => {
            calls.push({ file, args });
            return createMockChild(0);
        },
    });

    const result = await getTool(api, "request_secret").execute(
        "id-cli",
        {
            description: "Need token",
            channel_id: "telegram:123456789",
            secret_name: "cli_key",
        },
        {},
    );

    assert.equal(calls.length, 1, "CLI fallback should be attempted exactly once");
    assert.equal(calls[0].file, "openclaw");
    assert.deepEqual(calls[0].args.slice(0, 6), ["message", "send", "--channel", "telegram", "--target", "123456789"]);
    assert.match(result?.content?.[0]?.text ?? "", /Secret received and stored securely in memory/);
    disposeStoredSecret("cli_key");
}

async function testUsesSendMessageWhenSendTextMissing() {
    const api = createMockApi();
    const outbound = [];

    register(api, {
        requestSecretFlowFn: async ({ onSecretLink }) => {
            await onSecretLink("https://secrets.example/r/abc", "BLUE-FOX-42");
            return Buffer.from("s-1", "utf8");
        },
        cleanupFn: async () => { },
    });

    const result = await getTool(api, "request_secret").execute(
        "id-cli",
        {
            description: "Need token",
            channel_id: "telegram:123456789",
            secret_name: "t1",
        },
        { sendMessage: async (message) => outbound.push(message) },
    );

    assert.equal(outbound.length, 1, "Should use context.sendMessage when available");
    assert.match(result?.content?.[0]?.text ?? "", /Secret received and stored securely in memory/);

    disposeStoredSecret("t1");
}

async function testFailsWhenNoTransportAvailable() {
    const api = createMockApi();
    const captured = [];
    const originalError = console.error;
    try {
        console.error = (...args) => {
            captured.push(args.join(" "));
        };

        register(api, {
            requestSecretFlowFn: async ({ onSecretLink }) => {
                await onSecretLink("https://secrets.example/r/abc", "BLUE-FOX-42");
                return Buffer.from("s-2", "utf8");
            },
            cleanupFn: async () => { },
            execFileFn: () => createMockChild(1, "mock cli failure"),
        });

        const result = await getTool(api, "request_secret").execute("id-4", { description: "Need token" }, {});
        const output = result?.content?.[0]?.text ?? "";
        assert.match(output, /Error: request_secret requires routing params/);
        assert.equal(captured.length, 0, "Should fail before transport attempts when routing params are missing");
    } finally {
        console.error = originalError;
    }
}

async function testUsesRuntimeChannelWhenOtherTransportsMissing() {
    const api = createMockApi();
    const outbound = [];

    api.runtime = {
        channel: {
            sendText: async (message) => outbound.push(message),
        },
    };

    register(api, {
        requestSecretFlowFn: async ({ onSecretLink }) => {
            await onSecretLink("https://secrets.example/r/abc", "BLUE-FOX-42");
            return Buffer.from("s-3", "utf8");
        },
        cleanupFn: async () => { },
    });

    const result = await getTool(api, "request_secret").execute("id-5", { description: "Need token", channel_id: "telegram:555" }, {});

    assert.equal(outbound.length, 1, "Should use api.runtime.channel.sendText when available");
    assert.match(result?.content?.[0]?.text ?? "", /Secret received and stored securely in memory/);

    disposeStoredSecret("default");
}

async function testShutdownDisposesSecrets() {
    const api = createMockApi();

    register(api, {
        requestSecretFlowFn: async () => Buffer.from("to-be-disposed", "utf8"),
        cleanupFn: async () => { },
    });

    await getTool(api, "request_secret").execute("id-2", { description: "DB password", channel_id: "telegram:222" }, {});
    assert.ok(getStoredSecret("default"));

    for (const hook of api.state.hooks) {
        if (hook.event === "shutdown") {
            await hook.handler();
        }
    }

    assert.equal(getStoredSecret("default"), null);
}

async function testRequestSecretFlowPublishesJwksForJwtAuth() {
    const originalApiKey = process.env.AGENT_KRYPTOS_API_KEY;
    const originalFallbackApiKey = process.env.SPS_AGENT_API_KEY;
    delete process.env.AGENT_KRYPTOS_API_KEY;
    delete process.env.SPS_AGENT_API_KEY;

    const calls = {
        loadOrCreateGatewayIdentity: [],
        writeJwksFile: [],
        issueJwt: [],
        destroyKeyPair: 0,
        onSecretLink: [],
    };

    try {
        const plaintext = await requestSecretFlow({
            description: "Bridge JWT fallback secret request",
            agentId: "bridge-jwt-agent",
            identityOptions: {
                keyPath: "/tmp/bridge-jwt-test/gateway-key.json",
            },
            onSecretLink: async (secretUrl, confirmationCode) => {
                calls.onSecretLink.push({ secretUrl, confirmationCode });
            },
            moduleOverrides: {
                identity: {
                    async loadOrCreateGatewayIdentity(opts) {
                        calls.loadOrCreateGatewayIdentity.push(opts);
                        return { kid: "kid-1" };
                    },
                    async writeJwksFile(identity, jwksPath) {
                        calls.writeJwksFile.push({ identity, jwksPath });
                    },
                    async issueJwt(identity, agentId) {
                        calls.issueJwt.push({ identity, agentId });
                        return `jwt-for-${agentId}`;
                    },
                },
                keyManager: {
                    async generateKeyPair() {
                        return { publicKey: "public-key", privateKey: "private-key" };
                    },
                    async decrypt() {
                        return Buffer.from("bridge-secret", "utf8");
                    },
                    destroyKeyPair() {
                        calls.destroyKeyPair += 1;
                    },
                },
                AgentSkillRuntimeModule: {
                    AgentSecretRuntime: class {},
                },
                GatewaySpsClientModule: {
                    GatewaySpsClient: class {
                        async createSecretRequest() {
                            return {
                                requestId: "req-1",
                                secretUrl: "https://secrets.example/r/req-1",
                                confirmationCode: "BLUE-FOX-42",
                            };
                        }
                    },
                },
                SpsClientModule: {
                    SpsClient: class {
                        async pollStatus() {}
                        async retrieveSecret() {
                            return { enc: "enc", ciphertext: "ciphertext" };
                        }
                    },
                },
            },
        });

        assert.equal(plaintext.toString("utf8"), "bridge-secret");
        assert.equal(calls.loadOrCreateGatewayIdentity.length, 1);
        assert.equal(calls.writeJwksFile.length, 1);
        assert.equal(calls.writeJwksFile[0].jwksPath, "/tmp/bridge-jwt-test/jwks.json");
        assert.equal(calls.issueJwt.length, 2);
        assert.deepEqual(calls.issueJwt.map((call) => call.agentId), ["bridge-jwt-agent", "bridge-jwt-agent"]);
        assert.equal(calls.destroyKeyPair, 1);
        assert.equal(calls.onSecretLink.length, 1);
    } finally {
        await cleanupBridge();

        if (originalApiKey === undefined) {
            delete process.env.AGENT_KRYPTOS_API_KEY;
        } else {
            process.env.AGENT_KRYPTOS_API_KEY = originalApiKey;
        }

        if (originalFallbackApiKey === undefined) {
            delete process.env.SPS_AGENT_API_KEY;
        } else {
            process.env.SPS_AGENT_API_KEY = originalFallbackApiKey;
        }
    }
}

async function testReRequestFormat() {
    const api = createMockApi();
    const outbound = [];

    register(api, {
        requestSecretFlowFn: async ({ onSecretLink }) => {
            await onSecretLink("https://secrets.example/r/xyz", "RED-BULL-99");
            return Buffer.from("super-secret-value-2", "utf8");
        },
        cleanupFn: async () => { },
    });

    await getTool(api, "request_secret").execute(
        "id-rereq",
        { description: "DB Password", secret_name: "db_pass", channel_id: "telegram:111", re_request: true },
        { sendText: async (message) => outbound.push(message) },
    );

    assert.equal(outbound.length, 1, "Should send one user-facing link message");
    const sentMessage = outbound[0];
    assert.ok(sentMessage.includes("Re-enter your secret to continue"), "Message should contain the re-request prompt");
    assert.ok(!sentMessage.includes("Secure secret requested"), "Message should NOT contain the default prompt");

    disposeStoredSecret("db_pass");
}

async function testFulfillSecretExchangeUsesStoredSecret() {
    const api = createMockApi();
    const calls = [];

    register(api, {
        requestSecretFlowFn: async () => Buffer.from("super-secret-value", "utf8"),
        cleanupFn: async () => { },
        fulfillExchangeFlowFn: async (params) => {
            calls.push({
                fulfillmentToken: params.fulfillmentToken,
                secret: await params.resolveSecret("stripe.api_key.prod"),
                agentId: params.agentId,
            });
            return {
                exchangeId: "ex-123",
                secretName: "stripe.api_key.prod",
                fulfilledBy: params.agentId,
            };
        },
    });

    const requestTool = getTool(api, "request_secret");
    await requestTool.execute(
        "store-secret",
        { description: "Need token", secret_name: "stripe.api_key.prod", channel_id: "telegram:111" },
        {
            sendText: async () => { },
        },
    );

    const result = await getTool(api, "fulfill_secret_exchange").execute(
        "fulfill-1",
        { fulfillment_token: "token-abc" },
        {},
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fulfillmentToken, "token-abc");
    assert.equal(calls[0].secret.toString("utf8"), "super-secret-value");
    assert.match(result?.content?.[0]?.text ?? "", /Secret exchange fulfilled successfully/);

    disposeStoredSecret("stripe.api_key.prod");
}

async function testRequestSecretExchangeUsesOpenClawTransportAndStoresSecret() {
    const api = createMockApi();
    const sent = [];

    api.runtime = {
        agentToAgent: {
            send: async (payload) => sent.push(payload),
        },
    };

    register(api, {
        cleanupFn: async () => { },
        requestExchangeFlowFn: async ({ secretName, purpose, fulfillerId, transport, agentId }) => {
            await transport.deliverFulfillmentToken({
                kind: "agent-kryptos.exchange-fulfillment.v1",
                exchangeId: "ex-request-1",
                requesterId: agentId,
                fulfillerId,
                secretName,
                purpose,
                fulfillmentToken: "token-request-1",
            });

            return {
                exchangeId: "ex-request-1",
                fulfilledBy: fulfillerId,
                secret: Buffer.from("sk_exchange_123", "utf8"),
            };
        },
    });

    const result = await getTool(api, "request_secret_exchange").execute(
        "request-exchange-1",
        {
            secret_name: "stripe.api_key.prod",
            purpose: "charge-order",
            fulfiller_id: "session:payments",
        },
        {},
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, "session:payments");
    assert.match(sent[0].message, /fulfill_secret_exchange/);
    assert.match(result?.content?.[0]?.text ?? "", /Secret exchange completed and stored securely in memory/);
    assert.equal(getStoredSecret("stripe.api_key.prod")?.toString("utf8"), "sk_exchange_123");

    disposeStoredSecret("stripe.api_key.prod");
}

async function testRequestSecretExchangeFailsClosedWhenTargetCannotBeResolved() {
    const api = createMockApi();

    register(api, {
        cleanupFn: async () => { },
        createOpenClawAgentTransportFn: (apiArg, options) =>
            createOpenClawAgentTransport(apiArg, { ...options, directTargetFallback: false }),
        requestExchangeFlowFn: async ({ secretName, purpose, fulfillerId, transport, agentId }) => {
            await transport.deliverFulfillmentToken({
                kind: "agent-kryptos.exchange-fulfillment.v1",
                exchangeId: "ex-request-fail",
                requesterId: agentId,
                fulfillerId,
                secretName,
                purpose,
                fulfillmentToken: "token-request-fail",
            });

            return {
                exchangeId: "ex-request-fail",
                fulfilledBy: fulfillerId,
                secret: Buffer.from("should-not-store", "utf8"),
            };
        },
    });

    const result = await getTool(api, "request_secret_exchange").execute(
        "request-exchange-fail",
        {
            secret_name: "stripe.api_key.prod",
            purpose: "charge-order",
            fulfiller_id: "agent:missing-bot",
        },
        {},
    );

    assert.match(
        result?.content?.[0]?.text ?? "",
        /Failed to request secret exchange: OpenClaw transport could not resolve a target session/
    );
    assert.equal(getStoredSecret("stripe.api_key.prod"), null);
}

async function testCreateOpenClawAgentTransportUsesRuntimeAgentChannel() {
    const sent = [];
    const api = {
        runtime: {
            agentToAgent: {
                send: async (payload) => sent.push(payload),
            },
        },
    };

    const transport = createOpenClawAgentTransport(api);
    await transport.deliverFulfillmentToken({
        kind: "agent-kryptos.exchange-fulfillment.v1",
        exchangeId: "ex-transport",
        requesterId: "agent:crm-bot",
        fulfillerId: "session:payments",
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillmentToken: "token-transport",
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, "session:payments");
    assert.match(sent[0].message, /fulfill_secret_exchange/);
}

async function testResolveOpenClawAgentTargetUsesConfiguredMap() {
    const target = await resolveOpenClawAgentTarget(
        {},
        {
            fulfillerId: "agent:payment-bot",
        },
        {
            targetMap: {
                "agent:payment-bot": "session:payments",
            },
            directTargetFallback: false,
        },
    );

    assert.equal(target, "session:payments");
}

async function testResolveOpenClawAgentTargetUsesRuntimeResolver() {
    const target = await resolveOpenClawAgentTarget(
        {
            runtime: {
                sessions: {
                    resolveTarget: async (agentId) => agentId === "agent:ops-bot" ? "session:ops" : null,
                },
            },
        },
        {
            fulfillerId: "agent:ops-bot",
        },
        {
            directTargetFallback: false,
        },
    );

    assert.equal(target, "session:ops");
}

async function testResolveOpenClawAgentTargetUsesEnvMap() {
    const original = process.env.OPENCLAW_AGENT_TARGETS_JSON;
    process.env.OPENCLAW_AGENT_TARGETS_JSON = JSON.stringify({
        "agent:payment-bot": "session:payments-env",
    });

    try {
        const target = await resolveOpenClawAgentTarget(
            {},
            {
                fulfillerId: "agent:payment-bot",
            },
            {
                directTargetFallback: false,
            },
        );

        assert.equal(target, "session:payments-env");
    } finally {
        process.env.OPENCLAW_AGENT_TARGETS_JSON = original;
    }
}

async function testCreateOpenClawAgentTransportUsesAgentTargetMapBeforeFallback() {
    const sent = [];
    const api = {
        runtime: {
            agentToAgent: {
                send: async (payload) => sent.push(payload),
            },
        },
        agentTargetMap: {
            "agent:payment-bot": "session:payments",
        },
    };

    const transport = createOpenClawAgentTransport(api, { directTargetFallback: false });
    await transport.deliverFulfillmentToken({
        kind: "agent-kryptos.exchange-fulfillment.v1",
        exchangeId: "ex-transport-2",
        requesterId: "agent:crm-bot",
        fulfillerId: "agent:payment-bot",
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillmentToken: "token-transport-2",
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, "session:payments");
}

async function testBuildExchangeDeliveryMessageIncludesToolCall() {
    const message = buildExchangeDeliveryMessage({
        exchangeId: "ex-42",
        requesterId: "agent:crm-bot",
        fulfillerId: "agent:payment-bot",
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillmentToken: "token-42",
    });

    assert.match(message, /Agent-Kryptos secret exchange request/);
    assert.match(message, /fulfill_secret_exchange/);
    assert.match(message, /token-42/);
}

const tests = [
    {
        name: "request_secret does not return plaintext and stores secret in memory",
        run: testNoPlaintextExposure,
    },
    {
        name: "request_secret formats message correctly for re_request: true",
        run: testReRequestFormat,
    },
    {
        name: "request_secret uses OpenClaw CLI fallback",
        run: testUsesOpenClawCliFallback,
    },
    {
        name: "request_secret uses sendMessage when sendText is unavailable",
        run: testUsesSendMessageWhenSendTextMissing,
    },
    {
        name: "request_secret fails when no outbound transport is available",
        run: testFailsWhenNoTransportAvailable,
    },
    {
        name: "request_secret uses api.runtime.channel when other transports are unavailable",
        run: testUsesRuntimeChannelWhenOtherTransportsMissing,
    },
    {
        name: "shutdown hook disposes in-memory secrets",
        run: testShutdownDisposesSecrets,
    },
    {
        name: "requestSecretFlow publishes a JWKS when using JWT auth fallback",
        run: testRequestSecretFlowPublishesJwksForJwtAuth,
    },
    {
        name: "fulfill_secret_exchange uses the stored runtime secret",
        run: testFulfillSecretExchangeUsesStoredSecret,
    },
    {
        name: "request_secret_exchange uses OpenClaw transport and stores the exchanged secret",
        run: testRequestSecretExchangeUsesOpenClawTransportAndStoresSecret,
    },
    {
        name: "request_secret_exchange fails closed when no target can be resolved",
        run: testRequestSecretExchangeFailsClosedWhenTargetCannotBeResolved,
    },
    {
        name: "createOpenClawAgentTransport uses runtime agent messaging when available",
        run: testCreateOpenClawAgentTransportUsesRuntimeAgentChannel,
    },
    {
        name: "resolveOpenClawAgentTarget uses explicit target maps",
        run: testResolveOpenClawAgentTargetUsesConfiguredMap,
    },
    {
        name: "resolveOpenClawAgentTarget uses runtime session resolvers",
        run: testResolveOpenClawAgentTargetUsesRuntimeResolver,
    },
    {
        name: "resolveOpenClawAgentTarget uses OPENCLAW_AGENT_TARGETS_JSON",
        run: testResolveOpenClawAgentTargetUsesEnvMap,
    },
    {
        name: "createOpenClawAgentTransport uses mapped agent targets before fallback",
        run: testCreateOpenClawAgentTransportUsesAgentTargetMapBeforeFallback,
    },
    {
        name: "buildExchangeDeliveryMessage includes fulfill tool instructions",
        run: testBuildExchangeDeliveryMessageIncludesToolCall,
    },
];

let failures = 0;

for (const t of tests) {
    try {
        await t.run();
        console.log(`ok - ${t.name}`);
    } catch (err) {
        failures += 1;
        console.error(`not ok - ${t.name}`);
        console.error(err);
    }
}

if (failures > 0) {
    process.exitCode = 1;
}
