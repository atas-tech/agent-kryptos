/**
 * SPS Bridge — thin wrapper combining:
 * - Gateway JWT issuance (for authenticating to SPS)
 * - SPS client calls (create request, poll, retrieve)
 * - HPKE key management (generate, decrypt, destroy)
 *
 * This module works both inside an OpenClaw plugin and standalone (for E2E tests).
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Dynamic imports so this module works without compiling the monorepo
// (it references the dist/ outputs of sibling packages).
let _gatewayIdentity = null;
let _jwksPath = null;
let _tempDir = null;

/**
 * Lazy-load the compiled sibling packages.
 * Callers can override individual modules via `opts` for testing.
 */
async function loadModules(opts = {}) {
    const base = opts.basePath ?? path.resolve(import.meta.dirname ?? ".", "../..");

    const identity = opts.identity ?? await import(path.join(base, "packages/gateway/dist/identity.js"));
    const keyManager = opts.keyManager ?? await import(path.join(base, "packages/agent-skill/dist/key-manager.js"));
    const SpsClientMod = opts.SpsClientModule ?? await import(path.join(base, "packages/agent-skill/dist/sps-client.js"));
    const GatewaySpsClientMod = opts.GatewaySpsClientModule ?? await import(path.join(base, "packages/gateway/dist/sps-client.js"));

    return { identity, keyManager, SpsClient: SpsClientMod.SpsClient, GatewaySpsClient: GatewaySpsClientMod.GatewaySpsClient };
}

/**
 * Initialize gateway identity (generates ephemeral keys in a temp dir if no keyPath provided).
 */
async function ensureIdentity(identity, opts = {}) {
    if (_gatewayIdentity) return _gatewayIdentity;

    if (!opts.keyPath) {
        _tempDir = await mkdtemp(path.join(os.tmpdir(), "sps-plugin-"));
        opts.keyPath = path.join(_tempDir, "gateway-key.json");
    }

    _gatewayIdentity = await identity.loadOrCreateGatewayIdentity(opts);

    if (!process.env.SPS_GATEWAY_JWKS_FILE) {
        _jwksPath = path.join(path.dirname(opts.keyPath), "jwks.json");
        await identity.writeJwksFile(_gatewayIdentity, _jwksPath);
        process.env.SPS_GATEWAY_JWKS_FILE = _jwksPath;
    }

    return _gatewayIdentity;
}

/**
 * Full request_secret flow:
 *   1. Generate HPKE keypair
 *   2. POST /request to SPS
 *   3. Return link info (caller sends it to the user via their channel)
 *   4. Poll until submitted
 *   5. Retrieve + decrypt
 *   6. Destroy keypair
 *
 * @param {object} params
 * @param {string} params.description - Human-readable description of what the secret is for
 * @param {string} params.spsBaseUrl - SPS server base URL
 * @param {Function} params.onSecretLink - Callback with (secretUrl, confirmationCode) for sending to user
 * @param {object} [params.moduleOverrides] - Override loaded modules for testing
 * @param {object} [params.identityOptions] - Options for gateway identity
 * @returns {Promise<Buffer>} The decrypted secret plaintext bytes
 */
export async function requestSecretFlow(params) {
    const {
        description,
        spsBaseUrl = process.env.SPS_BASE_URL ?? "http://localhost:3100",
        onSecretLink,
        moduleOverrides = {},
        identityOptions = {},
    } = params;

    const modules = await loadModules(moduleOverrides);
    const gwIdentity = await ensureIdentity(modules.identity, identityOptions);

    // 1. Generate HPKE keypair
    const keyPair = await modules.keyManager.generateKeyPair();

    try {
        // 2. Create secret request via Gateway SPS client
        const gatewayToken = await modules.identity.issueJwt(gwIdentity, "agent-secrets-plugin");
        const gatewayClient = new modules.GatewaySpsClient({
            baseUrl: spsBaseUrl,
            gatewayBearerToken: gatewayToken,
        });

        const request = await gatewayClient.createSecretRequest({
            description,
            publicKey: keyPair.publicKey,
        });

        // 3. Let the caller deliver the link to the user (Telegram, etc.)
        await onSecretLink(request.secretUrl, request.confirmationCode);

        // 4. Poll until submitted
        const agentToken = await modules.identity.issueJwt(gwIdentity, "agent-secrets-agent");
        const agentClient = new modules.SpsClient({
            baseUrl: spsBaseUrl,
            gatewayBearerToken: agentToken,
        });

        await agentClient.pollStatus(request.requestId, 1000, 180_000, 60_000);

        // 5. Retrieve + decrypt
        const payload = await agentClient.retrieveSecret(request.requestId);
        const plaintext = await modules.keyManager.decrypt(keyPair.privateKey, payload.enc, payload.ciphertext);
        return Buffer.from(plaintext);
    } finally {
        // 6. Always destroy keypair
        modules.keyManager.destroyKeyPair(keyPair);
    }
}

/**
 * Cleanup any temp files created during identity initialization.
 */
export async function cleanup() {
    _gatewayIdentity = null;
    _jwksPath = null;
    if (_tempDir) {
        await rm(_tempDir, { recursive: true, force: true }).catch(() => { });
        _tempDir = null;
    }
}
