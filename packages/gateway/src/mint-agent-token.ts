import { loadOrCreateGatewayIdentity, issueJwt } from "./identity.js";

interface CliOptions {
  agentId: string;
  ttlSeconds?: number;
  keyPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let agentId = "";
  let ttlSeconds: number | undefined;
  let keyPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent" || arg === "--agent-id") {
      agentId = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--ttl") {
      const raw = argv[index + 1] ?? "";
      ttlSeconds = Number.parseInt(raw, 10);
      index += 1;
    } else if (arg === "--key-path") {
      keyPath = argv[index + 1] ?? "";
      index += 1;
    }
  }

  if (!agentId.trim()) {
    throw new Error("Usage: npm run mint-token -- --agent <agent-id> [--ttl <seconds>] [--key-path <path>]");
  }

  if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
    throw new Error("--ttl must be a positive integer");
  }

  return {
    agentId: agentId.trim(),
    ttlSeconds,
    keyPath: keyPath?.trim() || undefined
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identity = await loadOrCreateGatewayIdentity({
    keyPath: options.keyPath
  });
  const token = await issueJwt(identity, options.agentId, options.ttlSeconds);
  process.stdout.write(`${token}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
