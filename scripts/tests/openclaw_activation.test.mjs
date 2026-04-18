import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runResolver } from "../../packages/openclaw-plugin/blindpass-resolver.mjs";

function createResolverStdin(payload) {
    const stream = new PassThrough();
    stream.end(payload);
    return stream;
}

async function readStoreDocument(storePath) {
    try {
        return JSON.parse(await readFile(storePath, "utf8"));
    } catch (err) {
        if (err?.code === "ENOENT") {
            return {
                metadata: {},
                secrets: {},
            };
        }
        throw err;
    }
}

async function writeStoreDocument(storePath, document) {
    await writeFile(storePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

async function upsertSecret(storePath, secretName, value) {
    const document = await readStoreDocument(storePath);
    document.secrets = document.secrets ?? {};
    document.secrets[secretName] = {
        value,
        updated_at: new Date().toISOString(),
    };
    await writeStoreDocument(storePath, document);
}

class MockOpenClawGateway {
    constructor(storePath, ids) {
        this.storePath = storePath;
        this.ids = ids;
        this.snapshot = null;
    }

    async restart() {
        this.snapshot = await resolveSecretsFromStore(this.storePath, this.ids);
    }

    async reloadSecrets() {
        this.snapshot = await resolveSecretsFromStore(this.storePath, this.ids);
    }

    readSecretRef(id) {
        if (!this.snapshot) {
            throw new Error("Gateway snapshot not initialized.");
        }
        if (this.snapshot.errors?.[id]) {
            throw new Error(`SecretRef '${id}' unresolved: ${this.snapshot.errors[id].message}`);
        }
        if (!Object.prototype.hasOwnProperty.call(this.snapshot.values ?? {}, id)) {
            throw new Error(`SecretRef '${id}' unresolved: not materialized`);
        }
        return this.snapshot.values[id];
    }
}

async function resolveSecretsFromStore(storePath, ids) {
    const request = JSON.stringify({
        protocolVersion: 1,
        provider: "blindpass",
        ids,
    });

    const { exitCode, response } = await runResolver({
        argv: ["--store", storePath],
        stdin: createResolverStdin(request),
        readManagedSecretStoreFn: async ({ storePath: selectedPath }) => {
            const document = await readStoreDocument(selectedPath ?? storePath);
            return { document };
        },
    });

    assert.equal(exitCode, 0);
    assert.equal(response.protocolVersion, 1);
    return response;
}

async function testProvisionSecretThenRestartResolvesSecretRef() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "blindpass-openclaw-restart-"));
    const storePath = path.join(tempRoot, "secrets.enc.json");
    const secretId = "stripe.api_key.prod";
    const gateway = new MockOpenClawGateway(storePath, [secretId]);

    try {
        await gateway.restart();
        assert.throws(() => gateway.readSecretRef(secretId), /not found/);

        await upsertSecret(storePath, secretId, "sk_live_restart");
        assert.throws(() => gateway.readSecretRef(secretId), /not found/);

        await gateway.restart();
        assert.equal(gateway.readSecretRef(secretId), "sk_live_restart");
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

async function testProvisionSecretThenReloadResolvesSecretRef() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "blindpass-openclaw-reload-"));
    const storePath = path.join(tempRoot, "secrets.enc.json");
    const secretId = "github.token";
    const gateway = new MockOpenClawGateway(storePath, [secretId]);

    try {
        await gateway.restart();
        assert.throws(() => gateway.readSecretRef(secretId), /not found/);

        await upsertSecret(storePath, secretId, "ghp_reload_value");
        assert.throws(() => gateway.readSecretRef(secretId), /not found/);

        await gateway.reloadSecrets();
        assert.equal(gateway.readSecretRef(secretId), "ghp_reload_value");
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

async function testProvisionWithoutReloadDoesNotUpdateMaterializedConsumers() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "blindpass-openclaw-no-reload-"));
    const storePath = path.join(tempRoot, "secrets.enc.json");
    const ids = ["existing.secret", "new.secret"];
    const gateway = new MockOpenClawGateway(storePath, ids);

    try {
        await upsertSecret(storePath, "existing.secret", "initial-value");
        await gateway.restart();
        assert.equal(gateway.readSecretRef("existing.secret"), "initial-value");
        assert.throws(() => gateway.readSecretRef("new.secret"), /not found/);

        await upsertSecret(storePath, "new.secret", "new-value");
        assert.equal(gateway.readSecretRef("existing.secret"), "initial-value");
        assert.throws(() => gateway.readSecretRef("new.secret"), /not found/);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

async function testUpdatedSecretStaysOldUntilReloadOrRestart() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "blindpass-openclaw-rotate-"));
    const storePath = path.join(tempRoot, "secrets.enc.json");
    const secretId = "db.password";
    const gateway = new MockOpenClawGateway(storePath, [secretId]);

    try {
        await upsertSecret(storePath, secretId, "old-password");
        await gateway.restart();
        assert.equal(gateway.readSecretRef(secretId), "old-password");

        await upsertSecret(storePath, secretId, "new-password");
        assert.equal(gateway.readSecretRef(secretId), "old-password");

        await gateway.reloadSecrets();
        assert.equal(gateway.readSecretRef(secretId), "new-password");
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

const tests = [
    {
        name: "provision secret then restart gateway resolves SecretRef",
        run: testProvisionSecretThenRestartResolvesSecretRef,
    },
    {
        name: "provision secret then openclaw secrets reload resolves SecretRef",
        run: testProvisionSecretThenReloadResolvesSecretRef,
    },
    {
        name: "provisioning without reload/restart does not change already-materialized SecretRef state",
        run: testProvisionWithoutReloadDoesNotUpdateMaterializedConsumers,
    },
    {
        name: "updated secret value stays active as old snapshot until reload/restart",
        run: testUpdatedSecretStaysOldUntilReloadOrRestart,
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
