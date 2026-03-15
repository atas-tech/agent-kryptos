import { TextEncoder } from "util";

export function userJwtSecret() {
  const secret = process.env.SPS_USER_JWT_SECRET ?? "local-dev-user-jwt-secret";
  return new TextEncoder().encode(secret);
}
