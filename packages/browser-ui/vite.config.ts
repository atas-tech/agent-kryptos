import { defineConfig } from "vite";

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http: https: ws: wss:; form-action 'self'; frame-ancestors 'none'; frame-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export default defineConfig({
  server: {
    headers: securityHeaders,
    port: 5175
  },
  preview: {
    headers: securityHeaders
  }
});
