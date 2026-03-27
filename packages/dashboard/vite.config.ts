import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http: https: ws: wss:; form-action 'self'; frame-ancestors 'none'; frame-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const devServerHeaders = {
  "Permissions-Policy": securityHeaders["Permissions-Policy"],
  "Referrer-Policy": securityHeaders["Referrer-Policy"],
  "X-Content-Type-Options": securityHeaders["X-Content-Type-Options"],
  "X-Frame-Options": securityHeaders["X-Frame-Options"]
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: devServerHeaders,
    port: 5173
  },
  preview: {
    headers: securityHeaders
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    exclude: ["e2e/**", "test-results/**", "playwright-report/**"]
  }
});
