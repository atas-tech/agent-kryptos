import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
import path from "node:path";

const SERVICES = [
  { name: "Redis", port: 6380, start: "npm run redis:up" },
  { name: "PostgreSQL", port: 5433, start: "docker compose up -d postgres" },
  { name: "SPS Server", port: 3100, start: "npm run dev --workspace=packages/sps-server" },
  { name: "Dashboard", port: 5173, start: "npm run dev --workspace=packages/dashboard" },
];

async function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection(port, host);
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

async function startService(service) {
  console.log(`\n[Setup] Starting ${service.name}...`);
  const [cmd, ...args] = service.start.split(" ");
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, FORCE_COLOR: "true" }
  });

  // Give it a moment to boot
  await new Promise(r => setTimeout(r, 2000));
}

async function checkEnv() {
  const envPath = path.join(process.cwd(), "packages/sps-server/.env.test");
  try {
    await access(envPath, constants.F_OK);
    console.log("✅ packages/sps-server/.env.test exists");
  } catch {
    console.log("❌ packages/sps-server/.env.test is MISSING");
    console.log("   Action: cp packages/sps-server/.env.test.example packages/sps-server/.env.test");
    console.log("   Then configure your security secrets and connection strings.");
  }
}

async function main() {
  console.log("🚀 Agent Kryptos Dev Environment Setup\n");

  await checkEnv();
  console.log("");

  for (const service of SERVICES) {
    const open = await isPortOpen(service.port);
    if (open) {
      console.log(`✅ ${service.name} is already running on port ${service.port}`);
    } else {
      console.log(`❌ ${service.name} is NOT running on port ${service.port}`);
      
      if (service.name === "Redis") {
        await startService(service);
      } else if (service.name === "PostgreSQL") {
        console.log("   Please ensure PostgreSQL is running. (Docker Compose might have it)");
        // Try starting via docker compose just in case
        await startService(service);
      } else {
        // For Dashboard and SPS, we might want to start them in background or just tell the user
        console.log(`   Suggestion: Run '${service.start}' in a new terminal.`);
      }
    }
  }

  console.log("\nSetup check complete.");
  console.log("Use 'npm run dev' to start everything if services are still missing.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
