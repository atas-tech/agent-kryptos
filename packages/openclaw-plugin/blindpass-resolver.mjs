import { pathToFileURL } from "node:url";
import { readManagedSecretStore } from "./encrypted-store.mjs";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_STDIN_BYTES = 1024 * 1024;
const SECRET_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function printUsage() {
    process.stderr.write(
        [
            "Usage: blindpass-resolver [--store <path>]",
            "",
            "Reads OpenClaw exec-provider protocol v1 JSON from stdin and emits",
            "protocol-safe JSON with `values` and `errors` on stdout.",
            "",
            "Options:",
            "  --store <path>   Override managed store file path",
            "  -h, --help       Show this help text",
            "",
        ].join("\n"),
    );
}

export function parseResolverArgs(argv = process.argv.slice(2)) {
    let storePath;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--store") {
            const next = argv[i + 1];
            if (!next) {
                throw new Error("Missing value for --store.");
            }
            storePath = next;
            i += 1;
            continue;
        }
        if (arg === "-h" || arg === "--help") {
            return { help: true };
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return { help: false, storePath };
}

async function readStdinText(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
    return new Promise((resolve, reject) => {
        let text = "";
        let byteLength = 0;

        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            byteLength += Buffer.byteLength(chunk, "utf8");
            if (byteLength > maxBytes) {
                reject(new Error(`Input exceeds ${maxBytes} bytes.`));
                return;
            }
            text += chunk;
        });
        stream.on("end", () => resolve(text));
        stream.on("error", (err) => reject(err));
    });
}

function protocolResponse(values = {}, errors = {}) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        values,
        errors,
    };
}

function requestError(message) {
    return protocolResponse({}, {
        "__request__": { message },
    });
}

export function parseProtocolRequest(rawInput) {
    if (typeof rawInput !== "string" || rawInput.trim() === "") {
        throw new Error("Missing exec-provider request payload on stdin.");
    }

    let parsed;
    try {
        parsed = JSON.parse(rawInput);
    } catch {
        throw new Error("Invalid JSON payload.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Request payload must be a JSON object.");
    }

    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported protocolVersion '${String(parsed.protocolVersion)}'. Expected ${PROTOCOL_VERSION}.`);
    }

    if (!Array.isArray(parsed.ids)) {
        throw new Error("Request payload must include an `ids` array.");
    }

    const ids = [];
    for (const rawId of parsed.ids) {
        if (typeof rawId !== "string") {
            throw new Error("Each entry in `ids` must be a string.");
        }
        const id = rawId.trim();
        if (!id) {
            throw new Error("Secret IDs cannot be empty.");
        }
        ids.push(id);
    }

    return {
        provider: typeof parsed.provider === "string" ? parsed.provider.trim() : "",
        ids,
    };
}

export function resolveSecretEntries(ids, storeDocument, now = new Date()) {
    const values = {};
    const errors = {};
    const secrets = storeDocument?.secrets && typeof storeDocument.secrets === "object" && !Array.isArray(storeDocument.secrets)
        ? storeDocument.secrets
        : {};

    for (const id of ids) {
        if (!SECRET_ID_PATTERN.test(id)) {
            errors[id] = { message: "invalid secret id" };
            continue;
        }

        const entry = secrets[id];
        if (entry == null) {
            errors[id] = { message: "not found" };
            continue;
        }

        if (typeof entry === "string") {
            values[id] = entry;
            continue;
        }

        if (typeof entry !== "object" || Array.isArray(entry)) {
            errors[id] = { message: "not found" };
            continue;
        }

        if (typeof entry.expires_at === "string" && entry.expires_at.trim() !== "") {
            const expiresAtMs = Date.parse(entry.expires_at);
            if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now.getTime()) {
                errors[id] = { message: "expired" };
                continue;
            }
        }

        if (typeof entry.value !== "string") {
            errors[id] = { message: "not found" };
            continue;
        }

        values[id] = entry.value;
    }

    return protocolResponse(values, errors);
}

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Resolver timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

export async function runResolver(options = {}) {
    const {
        argv = process.argv.slice(2),
        stdin = process.stdin,
        env = process.env,
        now = new Date(),
        readManagedSecretStoreFn = readManagedSecretStore,
    } = options;

    const args = parseResolverArgs(argv);
    if (args.help) {
        printUsage();
        return { exitCode: 0, response: null };
    }

    const configuredTimeout = Number.parseInt(env.BLINDPASS_RESOLVER_TIMEOUT_MS ?? "", 10);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS;

    try {
        const rawInput = await readStdinText(stdin);
        const request = parseProtocolRequest(rawInput);

        const response = await withTimeout(
            (async () => {
                const store = await readManagedSecretStoreFn({
                    env,
                    runtimeMode: "mcp",
                    storePath: args.storePath,
                });
                return resolveSecretEntries(request.ids, store.document, now);
            })(),
            timeoutMs,
        );

        return { exitCode: 0, response };
    } catch (err) {
        const message = err?.message ?? String(err);
        return {
            exitCode: 0,
            response: requestError(message),
        };
    }
}

export async function main() {
    try {
        const { exitCode, response } = await runResolver();
        if (response) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
        }
        process.exitCode = exitCode;
    } catch (err) {
        const fallback = requestError("Resolver failed unexpectedly.");
        process.stdout.write(`${JSON.stringify(fallback)}\n`);
        process.stderr.write(`[blindpass] resolver failure: ${err?.message ?? String(err)}\n`);
        process.exitCode = 1;
    }
}

const currentEntryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentEntryHref) {
    await main();
}
