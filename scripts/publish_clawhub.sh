#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/publish_clawhub.sh [options]

Options:
  --bump patch|minor|major  Bump SKILL.md version and sync to JSON manifests.
  --stage-dir <dir>         Stage release artifacts into this directory.
  --publish                 Run `clawhub publish` from the staged directory.
  --skip-build              Skip `npm run build:skill` before validation.
  --dry-run                 Print actions without writing files or publishing.
  --help                    Show this help text.
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${ROOT_DIR}/packages/openclaw-plugin"
SKILL_FILE="${PLUGIN_DIR}/skills/blindpass/SKILL.md"
PLUGIN_PACKAGE_JSON="${PLUGIN_DIR}/package.json"
PLUGIN_MANIFEST_JSON="${PLUGIN_DIR}/openclaw.plugin.json"
DIST_DIR="${PLUGIN_DIR}/dist"

BUMP_KIND=""
STAGE_DIR=""
DO_PUBLISH=0
SKIP_BUILD=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump)
      if [[ $# -lt 2 ]]; then
        echo "[blindpass] missing value for --bump" >&2
        exit 1
      fi
      BUMP_KIND="$2"
      shift 2
      ;;
    --stage-dir)
      if [[ $# -lt 2 ]]; then
        echo "[blindpass] missing value for --stage-dir" >&2
        exit 1
      fi
      STAGE_DIR="$2"
      shift 2
      ;;
    --publish)
      DO_PUBLISH=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "[blindpass] unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

read_skill_version() {
  awk '
    BEGIN { in_frontmatter = 0; found = 0 }
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && $1 == "version:" {
      line = $0
      sub(/^version:[[:space:]]*"?/, "", line)
      sub(/"?[[:space:]]*$/, "", line)
      print line
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$SKILL_FILE"
}

write_skill_version() {
  local new_version="$1"
  local tmp
  tmp="$(mktemp)"

  awk -v new_version="$new_version" '
    BEGIN { in_frontmatter = 0; wrote_version = 0 }
    NR == 1 && $0 == "---" { in_frontmatter = 1; print; next }
    in_frontmatter && $0 == "---" {
      if (!wrote_version) {
        print "version: \"" new_version "\""
        wrote_version = 1
      }
      in_frontmatter = 0
      print
      next
    }
    in_frontmatter && $1 == "version:" {
      print "version: \"" new_version "\""
      wrote_version = 1
      next
    }
    { print }
  ' "$SKILL_FILE" > "$tmp"

  mv "$tmp" "$SKILL_FILE"
}

bump_semver() {
  local current="$1"
  local bump_kind="$2"
  local major minor patch

  if [[ ! "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[blindpass] invalid semver in SKILL.md: $current" >&2
    exit 1
  fi

  IFS='.' read -r major minor patch <<< "$current"

  case "$bump_kind" in
    patch)
      patch=$((patch + 1))
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    *)
      echo "[blindpass] --bump must be one of patch|minor|major" >&2
      exit 1
      ;;
  esac

  echo "${major}.${minor}.${patch}"
}

read_json_version() {
  local json_file="$1"
  node -e 'const fs = require("fs"); const p = process.argv[1]; const j = JSON.parse(fs.readFileSync(p, "utf8")); process.stdout.write(String(j.version ?? ""));' "$json_file"
}

write_json_version() {
  local json_file="$1"
  local new_version="$2"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const v = process.argv[2];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.version = v;
    fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n");
  ' "$json_file" "$new_version"
}

validate_dist_security() {
  if [[ ! -d "$DIST_DIR" ]]; then
    echo "[blindpass] dist directory missing: $DIST_DIR" >&2
    exit 1
  fi

  local required=(
    "blindpass.mjs"
    "index.mjs"
    "mcp-server.mjs"
    "blindpass-resolver.mjs"
    "openclaw.plugin.json"
    "skills/blindpass/SKILL.md"
    "LICENSE"
  )

  local missing=0
  for rel in "${required[@]}"; do
    if [[ ! -e "$DIST_DIR/$rel" ]]; then
      echo "[blindpass] missing required dist artifact: $rel" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi

  if find "$DIST_DIR" -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \) | grep -q '.'; then
    echo "[blindpass] security validation failed: .env files found in dist" >&2
    find "$DIST_DIR" -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \)
    exit 1
  fi

  if find "$DIST_DIR" -type d -name 'node_modules' | grep -q '.'; then
    echo "[blindpass] security validation failed: node_modules found in dist" >&2
    find "$DIST_DIR" -type d -name 'node_modules'
    exit 1
  fi

  if find "$DIST_DIR" -type f \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '.age-key*' -o -name '*gateway-key*' -o -name '*id_rsa*' -o -name '*id_ed25519*' \) | grep -q '.'; then
    echo "[blindpass] security validation failed: private key material found in dist" >&2
    find "$DIST_DIR" -type f \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '.age-key*' -o -name '*gateway-key*' -o -name '*id_rsa*' -o -name '*id_ed25519*' \)
    exit 1
  fi

  local leaked_path
  leaked_path="$(rg --files-with-matches --glob '!*.map' -n 'packages/|/Users/|[A-Za-z]:\\\\Users\\\\' "$DIST_DIR" -S | head -n 1 || true)"
  if [[ -n "$leaked_path" ]]; then
    echo "[blindpass] security validation failed: monorepo/absolute path leakage detected in dist file: $leaked_path" >&2
    exit 1
  fi

  local local_url_file
  local_url_file="$(rg --files-with-matches --glob '!*.map' -n 'http://localhost|https?://127\\.0\\.0\\.1|https?://0\\.0\\.0\\.0|https?://\[::1\]' "$DIST_DIR" -S | head -n 1 || true)"
  if [[ -n "$local_url_file" ]]; then
    echo "[blindpass] security validation failed: local/dev SPS URL found in dist file: $local_url_file" >&2
    exit 1
  fi
}

CURRENT_SKILL_VERSION="$(read_skill_version)"
TARGET_VERSION="$CURRENT_SKILL_VERSION"

if [[ -n "$BUMP_KIND" ]]; then
  TARGET_VERSION="$(bump_semver "$CURRENT_SKILL_VERSION" "$BUMP_KIND")"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[blindpass] dry-run"
  echo "[blindpass] current version: $CURRENT_SKILL_VERSION"
  echo "[blindpass] target version:  $TARGET_VERSION"
else
  if [[ "$TARGET_VERSION" != "$CURRENT_SKILL_VERSION" ]]; then
    echo "[blindpass] bumping version: $CURRENT_SKILL_VERSION -> $TARGET_VERSION"
    write_skill_version "$TARGET_VERSION"
    write_json_version "$PLUGIN_PACKAGE_JSON" "$TARGET_VERSION"
    write_json_version "$PLUGIN_MANIFEST_JSON" "$TARGET_VERSION"
  fi
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  npm run build:skill
fi

skill_version_now="$(read_skill_version)"
plugin_package_version="$(read_json_version "$PLUGIN_PACKAGE_JSON")"
plugin_manifest_version="$(read_json_version "$PLUGIN_MANIFEST_JSON")"

if [[ "$skill_version_now" != "$plugin_package_version" || "$skill_version_now" != "$plugin_manifest_version" ]]; then
  echo "[blindpass] version synchronization check failed" >&2
  echo "  SKILL.md:             $skill_version_now" >&2
  echo "  package.json:         $plugin_package_version" >&2
  echo "  openclaw.plugin.json: $plugin_manifest_version" >&2
  exit 1
fi

validate_dist_security

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[blindpass] dry-run complete: validation passed"
  exit 0
fi

if [[ -z "$STAGE_DIR" ]]; then
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blindpass-clawhub-${skill_version_now}-XXXXXX")"
else
  mkdir -p "$STAGE_DIR"
  if find "$STAGE_DIR" -mindepth 1 -print -quit | grep -q '.'; then
    echo "[blindpass] stage directory must be empty: $STAGE_DIR" >&2
    exit 1
  fi
fi

cp -R "$DIST_DIR"/. "$STAGE_DIR"/

echo "[blindpass] staged release: $STAGE_DIR"

if [[ "$DO_PUBLISH" -eq 1 ]]; then
  if ! command -v clawhub >/dev/null 2>&1; then
    echo "[blindpass] clawhub CLI not found on PATH" >&2
    exit 1
  fi
  (
    cd "$STAGE_DIR"
    clawhub publish
  )
  echo "[blindpass] publish complete"
else
  echo "[blindpass] publish skipped. Run this command when ready:"
  echo "  (cd "$STAGE_DIR" && clawhub publish)"
fi
