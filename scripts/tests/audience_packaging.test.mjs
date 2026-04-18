import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, "..", "..");
const PUBLISH_CLAWHUB_SCRIPT = path.join(ROOT_DIR, "scripts", "publish_clawhub.sh");
const PUBLISH_DIST_SCRIPT = path.join(ROOT_DIR, "scripts", "publish_dist.sh");

async function runCommand(command, args, options = {}) {
    const {
        cwd = ROOT_DIR,
        env = {},
        stdin = "",
    } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                ...env,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => reject(err));
        child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));

        child.stdin.end(stdin);
    });
}

async function ensureDistArtifacts() {
    const build = await runCommand("npm", ["run", "build:skill"]);
    assert.equal(build.exitCode, 0, `build:skill failed:\n${build.stdout}\n${build.stderr}`);
}

function encodeMcpFrame(payload) {
    const body = JSON.stringify(payload);
    const length = Buffer.byteLength(body, "utf8");
    return `Content-Length: ${length}\r\n\r\n${body}`;
}

function parseMcpFrame(buffer) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const contentLengthMatch = headerText.match(/content-length:\s*(\d+)/i);
    if (!contentLengthMatch) {
        throw new Error("MCP frame missing Content-Length header.");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) return null;

    return {
        message: JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")),
        remainder: buffer.slice(bodyEnd),
    };
}

async function readOneMcpResponse(stream, timeoutMs = 5000) {
    let buffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            const parsed = parseMcpFrame(buffer);
            if (parsed) {
                cleanup();
                resolve(parsed.message);
            }
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onEnd = () => {
            cleanup();
            reject(new Error("MCP process ended before sending a response."));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for MCP response after ${timeoutMs}ms.`));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            stream.off("data", onData);
            stream.off("error", onError);
            stream.off("end", onEnd);
        };

        stream.on("data", onData);
        stream.on("error", onError);
        stream.on("end", onEnd);
    });
}

async function stopProcess(child) {
    if (child.exitCode != null) return;

    child.kill("SIGTERM");
    const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);

    if (!exited && child.exitCode == null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
    }
}

async function testClawhubPathAndOpenclawPayload() {
    const dryRun = await runCommand("bash", [
        PUBLISH_CLAWHUB_SCRIPT,
        "--dry-run",
        "--skip-build",
    ]);
    assert.equal(dryRun.exitCode, 0, `publish_clawhub dry-run failed:\n${dryRun.stdout}\n${dryRun.stderr}`);
    assert.match(dryRun.stdout, /dry-run complete: validation passed/);

    const installClawhubDryRun = await runCommand("bash", [
        path.join(ROOT_DIR, "scripts", "install_skill.sh"),
        "--agent", "clawhub",
        "--skip-build",
        "--dry-run",
    ]);
    assert.equal(installClawhubDryRun.exitCode, 0, `install_skill clawhub dry-run failed:\n${installClawhubDryRun.stdout}\n${installClawhubDryRun.stderr}`);
    assert.match(installClawhubDryRun.stdout, /openclaw skills install blindpass/);

    const stageDir = await mkdtemp(path.join(os.tmpdir(), "blindpass-stage-clawhub-"));
    try {
        const stage = await runCommand("bash", [
            PUBLISH_DIST_SCRIPT,
            "--skip-build",
            "--skip-validate",
            "--stage-dir",
            stageDir,
        ]);
        assert.equal(stage.exitCode, 0, `publish_dist staging failed:\n${stage.stdout}\n${stage.stderr}`);

        await readFile(path.join(stageDir, "dist", "blindpass.mjs"), "utf8");
        const manifest = JSON.parse(await readFile(path.join(stageDir, "openclaw.plugin.json"), "utf8"));
        assert.equal(manifest.id, "blindpass");
    } finally {
        await rm(stageDir, { recursive: true, force: true });
    }
}

async function testMcpNpmPackagingAndRuntimeHandshake() {
    const stageDir = await mkdtemp(path.join(os.tmpdir(), "blindpass-stage-mcp-"));
    const npmCacheDir = await mkdtemp(path.join(os.tmpdir(), "blindpass-npm-cache-"));
    try {
        const stage = await runCommand("bash", [
            PUBLISH_DIST_SCRIPT,
            "--skip-build",
            "--skip-validate",
            "--stage-dir",
            stageDir,
        ]);
        assert.equal(stage.exitCode, 0, `publish_dist staging failed:\n${stage.stdout}\n${stage.stderr}`);

        const stagePackage = JSON.parse(await readFile(path.join(stageDir, "package.json"), "utf8"));
        assert.equal(stagePackage.name, "@blindpass/mcp-server");
        assert.deepEqual(stagePackage.bin, {
            "blindpass-mcp-server": "./dist/mcp-server.mjs",
            "blindpass-resolver": "./dist/blindpass-resolver.mjs",
        });

        const packDryRun = await runCommand("npm", ["pack", "--json", "--dry-run"], {
            cwd: stageDir,
            env: {
                NPM_CONFIG_CACHE: npmCacheDir,
            },
        });
        assert.equal(packDryRun.exitCode, 0, `npm pack --dry-run failed:\n${packDryRun.stdout}\n${packDryRun.stderr}`);
        const packJson = JSON.parse(packDryRun.stdout);
        const packFilePaths = (packJson?.[0]?.files ?? []).map((entry) => entry.path);
        assert.ok(packFilePaths.includes("dist/mcp-server.mjs"));
        assert.ok(packFilePaths.includes("dist/blindpass-resolver.mjs"));

        const child = spawn("node", [path.join(stageDir, "dist", "mcp-server.mjs")], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                BLINDPASS_AUTO_PERSIST: "false",
            },
        });

        let stderrOutput = "";
        child.stderr.on("data", (chunk) => {
            stderrOutput += chunk.toString("utf8");
        });

        try {
            child.stdin.write(encodeMcpFrame({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {},
            }));
            const response = await readOneMcpResponse(child.stdout);
            assert.equal(response?.result?.serverInfo?.name, "blindpass");
            assert.equal(child.exitCode, null, `staged MCP server exited unexpectedly: ${stderrOutput}`);
        } finally {
            await stopProcess(child);
        }
    } finally {
        await rm(stageDir, { recursive: true, force: true });
        await rm(npmCacheDir, { recursive: true, force: true });
    }
}

async function testDistRepoFallbackInstallerPath() {
    const stageRepo = await mkdtemp(path.join(os.tmpdir(), "blindpass-dist-repo-"));
    const stageDir = await mkdtemp(path.join(os.tmpdir(), "blindpass-dist-stage-"));
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "blindpass-home-"));

    try {
        await mkdir(stageRepo, { recursive: true });
        const sync = await runCommand("bash", [
            PUBLISH_DIST_SCRIPT,
            "--skip-build",
            "--skip-validate",
            "--repo-dir",
            stageRepo,
            "--stage-dir",
            stageDir,
            "--yes",
        ]);
        assert.equal(sync.exitCode, 0, `publish_dist sync failed:\n${sync.stdout}\n${sync.stderr}`);
        await readFile(path.join(stageRepo, "scripts", "install_skill.sh"), "utf8");

        const install = await runCommand("bash", [
            path.join(stageRepo, "scripts", "install_skill.sh"),
            "--mode",
            "global",
            "--agent",
            "codex",
            "--skip-build",
            "--yes",
        ], {
            cwd: stageRepo,
            env: {
                HOME: fakeHome,
            },
        });
        assert.equal(install.exitCode, 0, `dist-repo install fallback failed:\n${install.stdout}\n${install.stderr}`);
        await readFile(path.join(fakeHome, ".codex", "skills", "blindpass", "dist", "mcp-server.mjs"), "utf8");
    } finally {
        await rm(stageRepo, { recursive: true, force: true });
        await rm(stageDir, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
    }
}

const tests = [
    {
        name: "ClawHub/OpenClaw packaging path validates and stages plugin artifacts",
        run: testClawhubPathAndOpenclawPayload,
    },
    {
        name: "MCP npm packaging path exposes mcp-server/resolver and launches over stdio",
        run: testMcpNpmPackagingAndRuntimeHandshake,
    },
    {
        name: "Git dist-repo fallback path installs via staged install_skill.sh",
        run: testDistRepoFallbackInstallerPath,
    },
];

let failures = 0;

await ensureDistArtifacts();

for (const test of tests) {
    try {
        await test.run();
        console.log(`ok - ${test.name}`);
    } catch (err) {
        failures += 1;
        console.error(`not ok - ${test.name}`);
        console.error(err);
    }
}

if (failures > 0) {
    process.exitCode = 1;
}
