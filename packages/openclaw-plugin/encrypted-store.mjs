import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SUPPORTED_BACKEND = "sops";
const STORE_FILE_NAME = "secrets.enc.json";

function parseBooleanEnv(rawValue, defaultValue = false) {
    if (rawValue == null || rawValue === "") {
        return defaultValue;
    }
    const normalized = String(rawValue).trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
        return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
        return false;
    }
    return defaultValue;
}

function normalizeStoreDocument(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return {
            version: 1,
            secrets: {},
            metadata: {},
        };
    }

    if (!data.secrets || typeof data.secrets !== "object" || Array.isArray(data.secrets)) {
        data.secrets = {};
    }
    if (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata)) {
        data.metadata = {};
    }
    if (data.version == null) {
        data.version = 1;
    }

    return data;
}

async function runCommand(execFileFn, command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const stdin = options.stdin ?? null;

    return new Promise((resolve, reject) => {
        const child = execFileFn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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

        if (stdin != null) {
            child.stdin?.write(stdin);
        }
        child.stdin?.end();
    });
}

async function fileExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function ensureSopsAvailable(execFileFn) {
    try {
        await runCommand(execFileFn, "sops", ["--version"], { timeoutMs: 5000 });
    } catch (err) {
        throw new Error(
            "BLINDPASS_AUTO_PERSIST=true requires the `sops` CLI on PATH. Install sops or set BLINDPASS_AUTO_PERSIST=false."
        );
    }
}

async function readEncryptedStore(storePath, execFileFn) {
    if (!(await fileExists(storePath))) {
        return normalizeStoreDocument({});
    }

    const { stdout } = await runCommand(execFileFn, "sops", ["--decrypt", "--output-type", "json", storePath]);
    const parsed = JSON.parse(stdout);
    return normalizeStoreDocument(parsed);
}

async function writeEncryptedStore(storePath, data, execFileFn) {
    const storeDir = path.dirname(storePath);
    await mkdir(storeDir, { recursive: true });

    const tempRoot = await mkdir(path.join(os.tmpdir(), "blindpass-store"), { recursive: true }).then(() =>
        path.join(os.tmpdir(), "blindpass-store", `tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    );
    const plainPath = `${tempRoot}.plain.json`;
    const encryptedPath = `${storePath}.tmp`;

    try {
        await writeFile(plainPath, JSON.stringify(data, null, 2), { mode: 0o600 });
        const { stdout } = await runCommand(
            execFileFn,
            "sops",
            ["--encrypt", "--input-type", "json", "--output-type", "json", plainPath],
            { timeoutMs: 20000 },
        );

        await writeFile(encryptedPath, stdout, { mode: 0o600 });
        await rename(encryptedPath, storePath);
    } finally {
        await rm(plainPath, { force: true }).catch(() => { });
        await rm(encryptedPath, { force: true }).catch(() => { });
    }
}

export function resolveDefaultStorePath(env = process.env, platform = process.platform) {
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA?.trim();
        const base = localAppData || path.join(os.homedir(), "AppData", "Local");
        return path.join(base, "blindpass", STORE_FILE_NAME);
    }

    return path.join(os.homedir(), ".blindpass", STORE_FILE_NAME);
}

export function resolveManagedStoreConfig(env = process.env, platform = process.platform) {
    const autoPersist = parseBooleanEnv(env.BLINDPASS_AUTO_PERSIST, false);
    const backend = env.BLINDPASS_STORE_BACKEND?.trim().toLowerCase() || SUPPORTED_BACKEND;
    const storePath = env.BLINDPASS_STORE_PATH?.trim() || resolveDefaultStorePath(env, platform);
    return {
        autoPersist,
        backend,
        storePath,
    };
}

export async function persistManagedSecret(options) {
    const {
        name,
        value,
        env = process.env,
        platform = process.platform,
        execFileFn = spawn,
        now = new Date(),
    } = options;

    const config = resolveManagedStoreConfig(env, platform);
    if (!config.autoPersist) {
        return { persisted: false, storage: "runtime" };
    }

    if (config.backend !== SUPPORTED_BACKEND) {
        throw new Error(
            `Unsupported managed-store backend '${config.backend}'. Configure BLINDPASS_STORE_BACKEND=${SUPPORTED_BACKEND} or disable BLINDPASS_AUTO_PERSIST.`
        );
    }

    await ensureSopsAvailable(execFileFn);
    const document = await readEncryptedStore(config.storePath, execFileFn);

    const secretValue = Buffer.isBuffer(value) ? value.toString("utf8") : Buffer.from(value).toString("utf8");
    document.secrets[name] = {
        value: secretValue,
        updated_at: now.toISOString(),
    };
    document.metadata.updated_at = now.toISOString();
    document.metadata.backend = config.backend;

    await writeEncryptedStore(config.storePath, document, execFileFn);

    return {
        persisted: true,
        storage: "managed",
        backend: config.backend,
        storePath: config.storePath,
    };
}

