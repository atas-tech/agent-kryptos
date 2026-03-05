import assert from "node:assert/strict";
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
        { description: "AWS deployment token", secret_name: "aws_token" },
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

async function testShutdownDisposesSecrets() {
    const api = createMockApi();

    register(api, {
        requestSecretFlowFn: async () => Buffer.from("to-be-disposed", "utf8"),
        cleanupFn: async () => { },
    });

    await api.state.tool.execute("id-2", { description: "DB password" }, {});
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
