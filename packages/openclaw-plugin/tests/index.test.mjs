import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import register, { disposeStoredSecret, getStoredSecret } from "../index.mjs";

function createMockApi() {
    const state = {
        tool: null,
        hooks: [],
    };

    return {
        state,
        registerTool(tool) {
            state.tool = tool;
        },
        registerHook(event, handler, meta) {
            state.hooks.push({ event, handler, meta });
        },
    };
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

    assert.ok(api.state.tool, "Tool should be registered");

    const result = await api.state.tool.execute(
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

    const result = await api.state.tool.execute(
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

    const result = await api.state.tool.execute(
        "id-3",
        { description: "Need token", secret_name: "t1", channel_id: "telegram:123" },
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

        const result = await api.state.tool.execute("id-4", { description: "Need token" }, {});
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

    const result = await api.state.tool.execute("id-5", { description: "Need token", channel_id: "telegram:555" }, {});

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

    await api.state.tool.execute("id-2", { description: "DB password", channel_id: "telegram:222" }, {});
    assert.ok(getStoredSecret("default"));

    for (const hook of api.state.hooks) {
        if (hook.event === "shutdown") {
            await hook.handler();
        }
    }

    assert.equal(getStoredSecret("default"), null);
}

const tests = [
    {
        name: "request_secret does not return plaintext and stores secret in memory",
        run: testNoPlaintextExposure,
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
