import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWTPayload, type JWK } from "jose";

interface StoredIdentity {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

export interface GatewayIdentity {
  kid: string;
  privateKey: CryptoKey | KeyObject | Uint8Array;
  publicJwk: JWK;
  issuer: string;
  audience: string;
  role: string;
  defaultTtlSeconds: number;
}

export interface GatewayIdentityOptions {
  keyPath?: string;
  issuer?: string;
  audience?: string;
  role?: string;
  defaultTtlSeconds?: number;
}

export interface IssueWorkloadJwtOptions {
  agentId: string;
  spiffeId?: string;
  ttlSeconds?: number;
  extraClaims?: Record<string, unknown>;
}

function keyPathFromOptions(options: GatewayIdentityOptions): string {
  return options.keyPath ?? process.env.GATEWAY_KEY_PATH ?? path.resolve(process.cwd(), "gateway-key.json");
}

async function loadIdentityFromFile(keyPath: string): Promise<StoredIdentity | null> {
  try {
    const raw = await readFile(keyPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (!parsed.kid || !parsed.privateJwk || !parsed.publicJwk) {
      throw new Error(`Invalid gateway identity file: ${keyPath}`);
    }

    return {
      kid: parsed.kid,
      privateJwk: parsed.privateJwk,
      publicJwk: parsed.publicJwk
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function createIdentityFile(keyPath: string): Promise<StoredIdentity> {
  const { privateKey, publicKey } = await generateKeyPair("Ed25519", { extractable: true });
  const kid = randomUUID();

  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  privateJwk.kid = kid;
  privateJwk.alg = "EdDSA";
  privateJwk.use = "sig";

  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";

  const dir = path.dirname(keyPath);
  await mkdir(dir, { recursive: true });
  await writeFile(
    keyPath,
    JSON.stringify(
      {
        kid,
        privateJwk,
        publicJwk
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  return {
    kid,
    privateJwk,
    publicJwk
  };
}

export async function loadOrCreateGatewayIdentity(options: GatewayIdentityOptions = {}): Promise<GatewayIdentity> {
  const keyPath = keyPathFromOptions(options);
  const stored = (await loadIdentityFromFile(keyPath)) ?? (await createIdentityFile(keyPath));

  const privateKey = await importJWK(stored.privateJwk, "EdDSA", { extractable: false });

  return {
    kid: stored.kid,
    privateKey,
    publicJwk: stored.publicJwk,
    issuer: options.issuer ?? "gateway",
    audience: options.audience ?? "sps",
    role: options.role ?? "gateway",
    defaultTtlSeconds: options.defaultTtlSeconds ?? 300
  };
}

export function getJWKS(identity: GatewayIdentity): { keys: JWK[] } {
  return {
    keys: [
      {
        ...identity.publicJwk,
        kid: identity.kid,
        alg: "EdDSA",
        use: "sig"
      }
    ]
  };
}

export async function writeJwksFile(identity: GatewayIdentity, jwksPath: string): Promise<void> {
  const dir = path.dirname(jwksPath);
  await mkdir(dir, { recursive: true });
  await writeFile(jwksPath, JSON.stringify(getJWKS(identity), null, 2));
}

export async function issueJwt(
  identity: GatewayIdentity,
  agentId: string,
  ttlSeconds = identity.defaultTtlSeconds,
  extraClaims: Record<string, unknown> = {}
): Promise<string> {
  return issueWorkloadJwt(identity, {
    agentId,
    ttlSeconds,
    extraClaims
  });
}

export function buildSpiffeId(trustDomain: string, pathSegments: string[]): string {
  const normalizedTrustDomain = trustDomain.trim().replace(/^spiffe:\/\//, "").replace(/\/+$/, "");
  const normalizedPath = pathSegments
    .map((segment) => segment.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

  if (!normalizedTrustDomain || !normalizedPath) {
    throw new Error("SPIFFE trust domain and path must be non-empty");
  }

  return `spiffe://${normalizedTrustDomain}/${normalizedPath}`;
}

export async function issueWorkloadJwt(
  identity: GatewayIdentity,
  options: IssueWorkloadJwtOptions
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? identity.defaultTtlSeconds;
  const claims: Record<string, unknown> = {
    role: identity.role,
    workload_mode: options.spiffeId ? "spiffe-jwt" : "local-jwt",
    ...options.extraClaims
  };

  if (options.spiffeId) {
    claims.spiffe_id = options.spiffeId;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: identity.kid, typ: "JWT" })
    .setIssuer(identity.issuer)
    .setAudience(identity.audience)
    .setSubject(options.agentId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(identity.privateKey);
}

export interface JwtClaims extends JWTPayload {
  role: string;
}
