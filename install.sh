#!/usr/bin/env bash
# Registers otel-genai-hook in a coding agent's configuration.
# Supported agents: Codex CLI / Claude Code
#
#   ./install.sh --codex
#   ./install.sh --claude
#   ./install.sh --all
#   ./install.sh --claude --project
#   ./install.sh --all --uninstall
#
# One of --codex / --claude / --all is required, so nothing is registered by accident.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE:-node}"

scope="global"
mode="install"
entry="auto"
platform=""
for arg in "$@"; do
  case "$arg" in
    --codex|--claude|--all)
      if [ -n "$platform" ]; then
        echo "pass only one of --codex / --claude / --all" >&2
        exit 2
      fi
      platform="${arg#--}"
      ;;
    --project) scope="project" ;;
    --global) scope="global" ;;
    --source) entry="source" ;;
    --dist) entry="dist" ;;
    --uninstall) mode="uninstall" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$platform" ]; then
  echo "pass a target: --codex, --claude, or --all" >&2
  exit 2
fi

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "node not found (set NODE=/path/to/node)" >&2
  exit 1
fi

supports_ts() {
  "$NODE" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18) ? 0 : 1);
  '
}

if [ "$mode" = "install" ]; then
  case "$entry" in
    dist) hook="$HERE/dist/otel-genai-hook.js" ;;
    source) hook="$HERE/src/otel-genai-hook.ts" ;;
    auto)
      if [ -f "$HERE/dist/otel-genai-hook.js" ]; then
        hook="$HERE/dist/otel-genai-hook.js"
      elif supports_ts; then
        hook="$HERE/src/otel-genai-hook.ts"
      else
        echo "dist/otel-genai-hook.js is missing; build it first:" >&2
        echo "  cd $HERE && npm install && npm run build" >&2
        exit 1
      fi
      ;;
  esac
  if [ ! -f "$hook" ]; then
    echo "$hook does not exist" >&2
    exit 1
  fi
else
  hook="$HERE/dist/otel-genai-hook.js"
fi

if [ "$scope" = "global" ]; then
  codex_target="${CODEX_HOME:-$HOME/.codex}/hooks.json"
  claude_target="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
else
  codex_target="$PWD/.codex/hooks.json"
  claude_target="$PWD/.claude/settings.json"
fi

MODE="$mode" PLATFORM="$platform" CODEX_TARGET="$codex_target" \
CLAUDE_TARGET="$claude_target" CODEX_TEMPLATE="$HERE/hooks.codex.json" \
CLAUDE_TEMPLATE="$HERE/hooks.claude.json" NODE_COMMAND="$NODE" HOOK_PATH="$hook" \
"$NODE" <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const mode = process.env.MODE;
const platform = process.env.PLATFORM;
const marker = "otel-genai-hook";

const targets = [];
if (platform === "codex" || platform === "all") {
  targets.push({
    runtime: "codex",
    target: process.env.CODEX_TARGET,
    template: process.env.CODEX_TEMPLATE,
  });
}
if (platform === "claude" || platform === "all") {
  targets.push({
    runtime: "claude",
    target: process.env.CLAUDE_TARGET,
    template: process.env.CLAUDE_TEMPLATE,
  });
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const commandFor = (runtime) =>
  `${shellQuote(process.env.NODE_COMMAND)} ${shellQuote(process.env.HOOK_PATH)} --runtime=${runtime}`;

const strip = (entries) => {
  const kept = [];
  for (const entry of entries) {
    const inner = (entry.hooks ?? []).filter(
      (hook) =>
        !String(hook.command ?? "").includes(marker) &&
        !String((hook.args ?? []).join(" ")).includes(marker),
    );
    if (inner.length > 0) {
      entry.hooks = inner;
      kept.push(entry);
    } else if (!entry.hooks || entry.hooks.length === 0) {
      kept.push(entry);
    }
  }
  return kept;
};

const count = (entries) =>
  entries.reduce((total, entry) => total + (entry.hooks?.length ?? 0), 0);

for (const item of targets) {
  const target = item.target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let existing = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, "utf8")) || {};
    } catch {
      console.error(`${target} is not valid JSON; fix or move it first`);
      process.exit(1);
    }
    fs.copyFileSync(target, `${target}.bak`);
  }

  const hooks = (existing.hooks ??= {});
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const before = count(entries);
    hooks[event] = strip(entries);
    removed += before - count(hooks[event]);
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }

  if (mode === "install") {
    const template = JSON.parse(fs.readFileSync(item.template, "utf8")).hooks;
    const command = commandFor(item.runtime);
    for (const [event, entries] of Object.entries(template)) {
      for (const raw of entries) {
        const entry = JSON.parse(JSON.stringify(raw).replaceAll("__HOOK_COMMAND__", command));
        const bucket = (hooks[event] ??= []);
        const slot = bucket.find((candidate) => (candidate.matcher ?? "") === (entry.matcher ?? ""));
        if (slot) {
          (slot.hooks ??= []).push(...entry.hooks);
        } else {
          bucket.push(entry);
        }
      }
    }
  }

  fs.writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  const action = mode === "install" ? "installed" : "uninstalled";
  console.log(
    `  ✓ ${action} otel-genai-hook for ${item.runtime} in ${target} ` +
      `(removed ${removed} stale entries)`,
  );
}
JS

if [ "$mode" = "install" ]; then
  cat <<EOF

Registered for: $platform
Command:        $NODE $hook --runtime=<codex|claude>

Spans go to http://localhost:4318/v1/traces by default. Common settings:

  export CAT_OTEL_ENDPOINT=http://collector.example.com:4318
  export CAT_OTEL_HEADERS="Authorization=Bearer \$TOKEN"
  export CAT_OTEL_DEBUG=1

Optional — tag every span and metric with who ran the session. The keys land in the
OTLP resource, which both /v1/traces and /v1/metrics carry:

  export OTEL_RESOURCE_ATTRIBUTES="user.email=\$(git config user.email),enduser.id=\$(whoami)"

This sends personal data to the Collector, so enable it only if your retention policy
allows it.
EOF
fi
