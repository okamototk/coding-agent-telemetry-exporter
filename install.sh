#!/usr/bin/env bash
# Registers otel-genai-hook in a coding agent's configuration.
# Supported agents: Codex CLI / Claude Code / Kiro CLI
#
#   ./install.sh --codex
#   ./install.sh --claude
#   ./install.sh --kiro --agent my-agent
#   ./install.sh --all
#   ./install.sh --claude --project
#   ./install.sh --all --uninstall
#
# One of --codex / --claude / --kiro / --all is required, so nothing is registered by accident.
#
# Kiro CLI keeps hooks in an agent config rather than in one settings file, and its built-in
# kiro_default agent cannot take them, so --kiro patches the agent configs in
# ~/.kiro/agents (or ./.kiro/agents with --project). --agent NAME picks one, creating it if
# it does not exist yet; without it, every config already in that directory is patched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE:-node}"

scope="global"
mode="install"
entry="auto"
platform=""
agent=""
while [ $# -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --codex|--claude|--kiro|--all)
      if [ -n "$platform" ]; then
        echo "pass only one of --codex / --claude / --kiro / --all" >&2
        exit 2
      fi
      platform="${arg#--}"
      ;;
    --project) scope="project" ;;
    --global) scope="global" ;;
    --source) entry="source" ;;
    --dist) entry="dist" ;;
    --uninstall) mode="uninstall" ;;
    --agent)
      shift
      if [ $# -eq 0 ]; then
        echo "--agent needs a name" >&2
        exit 2
      fi
      agent="$1"
      ;;
    --agent=*) agent="${arg#--agent=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$platform" ]; then
  echo "pass a target: --codex, --claude, --kiro, or --all" >&2
  exit 2
fi

if [ -n "$agent" ] && [ "$platform" = "codex" -o "$platform" = "claude" ]; then
  echo "--agent applies to --kiro only" >&2
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
  kiro_target="${KIRO_HOME:-$HOME/.kiro}/agents"
else
  codex_target="$PWD/.codex/hooks.json"
  claude_target="$PWD/.claude/settings.json"
  kiro_target="$PWD/.kiro/agents"
fi

MODE="$mode" PLATFORM="$platform" CODEX_TARGET="$codex_target" \
CLAUDE_TARGET="$claude_target" KIRO_TARGET="$kiro_target" KIRO_AGENT="$agent" \
CODEX_TEMPLATE="$HERE/hooks.codex.json" CLAUDE_TEMPLATE="$HERE/hooks.claude.json" \
KIRO_TEMPLATE="$HERE/hooks.kiro.json" NODE_COMMAND="$NODE" HOOK_PATH="$hook" \
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

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    console.error(`${file} is not valid JSON; fix or move it first`);
    process.exit(1);
  }
};

/**
 * Kiro CLI declares hooks inside an agent config, as
 * `{"hooks": {"<trigger>": [{"command": ..., "timeout_ms": ...}]}}` — a flatter shape than
 * the Codex / Claude `{"<event>": [{"matcher": ..., "hooks": [...]}]}`, and spread over one
 * file per agent instead of one settings file, so it gets its own pass.
 */
const installKiro = () => {
  const directory = process.env.KIRO_TARGET;
  const named = process.env.KIRO_AGENT;
  let files;
  if (named) {
    files = [path.join(directory, `${named}.json`)];
  } else {
    let entries = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      entries = [];
    }
    files = entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
  }
  if (files.length === 0) {
    const message =
      `no agent config in ${directory}. Kiro keeps hooks per agent and its built-in\n` +
      "  kiro_default cannot take them, so name one: ./install.sh --kiro --agent <name>\n" +
      "  (or create it first with `kiro-cli agent create <name>`)";
    // Fatal only when kiro is the target that was asked for; --all must not fail because
    // Kiro CLI is not set up on this machine.
    if (platform === "kiro" && mode === "install") {
      console.error(message);
      process.exit(1);
    }
    console.log(`  - skipped kiro: ${message.split("\n")[0]}`);
    return;
  }

  for (const file of files) {
    const fresh = !fs.existsSync(file);
    if (fresh && mode !== "install") {
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A new config mirrors what `kiro-cli agent create` writes, so the agent behaves like
    // any other; an existing one is only ever added to.
    const config = fresh
      ? {
          name: path.basename(file, ".json"),
          description: "",
          prompt: null,
          mcpServers: {},
          tools: ["*"],
          toolAliases: {},
          allowedTools: [],
          resources: [],
          toolsSettings: {},
          includeMcpJson: true,
          model: null,
          permissions: { rules: [] },
        }
      : readJson(file);
    if (!fresh) {
      fs.copyFileSync(file, `${file}.bak`);
    }

    const hooks = (config.hooks ??= {});
    let removed = 0;
    for (const trigger of Object.keys(hooks)) {
      const entries = Array.isArray(hooks[trigger]) ? hooks[trigger] : [];
      const kept = entries.filter((entry) => !String(entry?.command ?? "").includes(marker));
      removed += entries.length - kept.length;
      if (kept.length > 0) {
        hooks[trigger] = kept;
      } else {
        delete hooks[trigger];
      }
    }

    if (mode === "install") {
      const template = JSON.parse(fs.readFileSync(process.env.KIRO_TEMPLATE, "utf8")).hooks;
      const command = commandFor("kiro");
      for (const [trigger, entries] of Object.entries(template)) {
        for (const raw of entries) {
          const entry = JSON.parse(JSON.stringify(raw).replaceAll("__HOOK_COMMAND__", command));
          (hooks[trigger] ??= []).push(entry);
        }
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete config.hooks;
    }

    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const action = mode === "install" ? (fresh ? "created" : "installed") : "uninstalled";
    console.log(
      `  ✓ ${action} otel-genai-hook for kiro in ${file} (removed ${removed} stale entries)`,
    );
  }
};

if (platform === "kiro" || platform === "all") {
  installKiro();
}

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
    existing = readJson(target);
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
Command:        $NODE $hook --runtime=<codex|claude|kiro>

Spans go to http://localhost:4318/v1/traces by default. Common settings:

  export CAT_OTEL_ENDPOINT=http://collector.example.com:4318
  export CAT_OTEL_HEADERS="Authorization=Bearer \$TOKEN"
  export CAT_OTEL_DEBUG=1

Optional — tag every span and metric with who ran the session. The keys land in the
OTLP resource, which both /v1/traces and /v1/metrics carry:

  export CAT_OTEL_RESOURCE_ATTRIBUTES="user.email=\$(git config user.email),enduser.id=\$(whoami)"

This sends personal data to the Collector, so enable it only if your retention policy
allows it.
EOF
  if [ "$platform" = "kiro" ] || [ "$platform" = "all" ]; then
    cat <<EOF

Kiro CLI runs the hooks of the agent the session uses, and its built-in kiro_default
carries none, so start the session on a patched agent:

  kiro-cli chat --agent <name>          # or make it the default, once:
  kiro-cli agent set-default <name>

Kiro meters turns in credits, not tokens. The credits are reported as
kiro.usage.credits; to also get money, say what a credit costs you:

  export CAT_OTEL_KIRO_CREDIT_USD=0.02
EOF
  fi
fi
