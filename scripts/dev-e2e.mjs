#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPath = path.resolve(__dirname, '..');

const commonEnv = {
  ...process.env,
  NODE_ENV: 'test',
  SPS_PG_INTEGRATION: '1',
  SPS_ENABLE_TEST_SEED_ROUTES: '1',
  SPS_E2E_SEED_TOKEN: 'blindpass-e2e-seed-token',
  SPS_HMAC_SECRET: 'blindpass-e2e-hmac-secret',
  SPS_USER_JWT_SECRET: 'blindpass-e2e-user-jwt-secret',
  SPS_AGENT_JWT_SECRET: 'blindpass-e2e-agent-jwt-secret',
  SPS_USER_REFRESH_JWT_SECRET: 'blindpass-e2e-user-refresh-jwt-secret',
  SPS_HOSTED_MODE: '1',
  SPS_X402_ENABLED: '1',
  SPS_X402_FACILITATOR_URL: 'http://127.0.0.1:3101',
  VITE_SPS_API_URL: 'http://127.0.0.1:3100',
};

const servers = [
  {
    name: 'SPS',
    command: 'npm',
    args: ['run', 'dev', '--workspace', 'packages/sps-server'],
    env: { ...commonEnv, PORT: '3100' }
  },
  {
    name: 'Dashboard',
    command: 'npm',
    args: ['run', 'dev', '--workspace', 'packages/dashboard'],
    env: { ...commonEnv, PORT: '5173' }
  },
  {
    name: 'Browser-UI',
    command: 'npm',
    args: ['run', 'dev', '--workspace', 'packages/browser-ui'],
    env: { ...commonEnv, PORT: '5175' }
  }
];

const processes = [];

console.log('Starting E2E servers in isolation...');

for (const server of servers) {
  const proc = spawn(server.command, server.args, {
    cwd: rootPath,
    env: server.env,
    stdio: 'inherit',
    shell: true
  });

  proc.on('error', (err) => {
    console.error(`Failed to start ${server.name}:`, err);
  });

  processes.push(proc);
}

process.on('SIGINT', () => {
  console.log('\nShutting down E2E servers...');
  for (const proc of processes) {
    proc.kill();
  }
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('\nShutting down E2E servers...');
  for (const proc of processes) {
    proc.kill();
  }
  process.exit();
});
