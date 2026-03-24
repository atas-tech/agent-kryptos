import { TextEncoder } from "util";
import { resolveRequiredSecret } from "./secrets.js";

export function userJwtSecret() {
  const secret = resolveRequiredSecret("SPS_USER_JWT_SECRET");
  return new TextEncoder().encode(secret);
}
