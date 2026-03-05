import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { verifyPayload } from "../services/crypto.js";
import type { RequestScope } from "../types.js";

let jwksCache: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksCachePath: string | null = null;

async function getJwksVerifier() {
  const path = process.env.SPS_GATEWAY_JWKS_FILE;
  if (!path) {
    return null;
  }

  if (!jwksCache || jwksCachePath !== path) {
    const jwks = JSON.parse(await readFile(path, "utf8"));
    jwksCache = createLocalJWKSet(jwks);
    jwksCachePath = path;
  }

  return jwksCache;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export async function requireGatewayAuth(req: FastifyRequest, reply: FastifyReply): Promise<JWTPayload | null> {
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Missing bearer token" });
    return null;
  }

  try {
    const jwks = await getJwksVerifier();
    if (!jwks) {
      reply.code(500).send({ error: "Gateway JWK not configured" });
      return null;
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: "gateway",
      audience: "sps"
    });

    if (payload.role !== "gateway" || !payload.sub) {
      reply.code(401).send({ error: "Invalid gateway claims" });
      return null;
    }

    return payload;
  } catch {
    reply.code(401).send({ error: "Invalid token" });
    return null;
  }
}

export function requireBrowserSig(
  req: FastifyRequest<{ Params: { id: string }; Querystring: { sig?: string } }>,
  reply: FastifyReply,
  scope: RequestScope,
  hmacSecret: string
): { exp: number } | null {
  const sig = req.query.sig;
  if (!sig) {
    reply.code(403).send({ error: "Missing signature" });
    return null;
  }

  const result = verifyPayload(req.params.id, scope, sig, hmacSecret);
  if (!result.ok) {
    if (result.reason === "expired") {
      reply.code(410).send({ error: "Request expired" });
      return null;
    }

    reply.code(403).send({ error: "Invalid signature" });
    return null;
  }

  return { exp: result.exp };
}
