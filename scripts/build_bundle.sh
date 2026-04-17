#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${ROOT_DIR}/packages/openclaw-plugin"
DIST_DIR="${PLUGIN_DIR}/dist"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/skills"

echo "[blindpass] building workspace dependencies for bundle inputs..."
(cd "${ROOT_DIR}" && npm run build --workspace=packages/gateway)
(cd "${ROOT_DIR}" && npm run build --workspace=packages/agent-skill)

echo "[blindpass] bundling plugin entrypoints with esbuild..."
(cd "${ROOT_DIR}" && npx --yes esbuild "${PLUGIN_DIR}/blindpass-core.mjs" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --minify \
  --outfile="${DIST_DIR}/blindpass.mjs")

{
  echo "#!/usr/bin/env node"
  cat "${PLUGIN_DIR}/mcp-server.mjs"
} > "${DIST_DIR}/mcp-server.mjs"

{
  echo "#!/usr/bin/env node"
  cat "${PLUGIN_DIR}/blindpass-resolver.mjs"
} > "${DIST_DIR}/blindpass-resolver.mjs"

cat > "${DIST_DIR}/index.mjs" <<'EOF'
export { default } from "./blindpass.mjs";
export * from "./blindpass.mjs";
EOF

cp "${PLUGIN_DIR}/openclaw.plugin.json" "${DIST_DIR}/openclaw.plugin.json"
cp "${PLUGIN_DIR}/LICENSE" "${DIST_DIR}/LICENSE"
cp -R "${PLUGIN_DIR}/skills/blindpass" "${DIST_DIR}/skills/blindpass"

chmod +x "${DIST_DIR}/mcp-server.mjs" "${DIST_DIR}/blindpass-resolver.mjs"

echo "[blindpass] bundle staged in ${DIST_DIR}"
