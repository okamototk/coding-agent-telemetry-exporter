#!/usr/bin/env bash
# Registers otel-genai-hook in a coding agent's configuration.
# Supported agents: Codex CLI / Claude Code / Kiro CLI
set -euo pipefail

usage() {
  cat <<'USAGE'
Registers otel-genai-hook in a coding agent's configuration.
Supported agents: Codex CLI / Claude Code / Kiro CLI

  ./install.sh --codex
  ./install.sh --claude
  ./install.sh --kiro --agent my-agent
  ./install.sh --all
  ./install.sh --claude --project
  ./install.sh --all --uninstall
  ./install.sh --all --dry-run

Targets (exactly one is required, so nothing is registered by accident):
  --codex | --claude | --kiro | --all

Options:
  --global        Write the user-level config (default)
  --project       Write ./.codex, ./.claude, ./.kiro in the current directory
  --source        Register src/otel-genai-hook.ts (needs Node >= 22.18 / >= 23.6)
  --dist          Register dist/otel-genai-hook.js (run `npm run build` first)
  --agent NAME    Kiro only: the agent config to patch, created if absent
  --uninstall     Remove this hook's entries, leaving every other hook in place
  --dry-run       Report what would change without writing anything
  -h, --help      Show this message

Kiro CLI keeps hooks in an agent config rather than in one settings file, and its built-in
kiro_default agent cannot take them, so --kiro patches the agent configs in
~/.kiro/agents (or ./.kiro/agents with --project). --agent NAME picks one, creating it if
it does not exist yet; without it, every config already in that directory is patched.

Environment:
  NODE            The node binary to register (default: the one on PATH)
  CODEX_HOME / CLAUDE_CONFIG_DIR / KIRO_HOME    Override where the config lives
USAGE
}

# Resolve symlinks so that installing through a symlinked install.sh still registers the
# real checkout. readlink -f is not portable to macOS, hence the loop.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  link="$(readlink "$SOURCE")"
  case "$link" in
    /*) SOURCE="$link" ;;
    *) SOURCE="$(cd -P "$(dirname "$SOURCE")" && pwd)/$link" ;;
  esac
done
HERE="$(cd -P "$(dirname "$SOURCE")" && pwd)"
NODE="${NODE:-node}"

scope="global"
mode="install"
entry="auto"
platform=""
agent=""
dry_run="0"
while [ $# -gt 0 ]; do
  arg="$1"
  case "$arg" in
    -h|--help) usage; exit 0 ;;
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
    --dry-run) dry_run="1" ;;
    --agent)
      shift
      if [ $# -eq 0 ]; then
        echo "--agent needs a name" >&2
        exit 2
      fi
      agent="$1"
      ;;
    --agent=*) agent="${arg#--agent=}" ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "run './install.sh --help' for usage" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$platform" ]; then
  echo "pass a target: --codex, --claude, --kiro, or --all" >&2
  echo "run './install.sh --help' for usage" >&2
  exit 2
fi

if [ -n "$agent" ] && [[ "$platform" = "codex" || "$platform" = "claude" ]]; then
  echo "--agent applies to --kiro only" >&2
  exit 2
fi

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "node not found (set NODE=/path/to/node)" >&2
  exit 1
fi
# Register an absolute path. A bare `node` resolves against the PATH of whatever launched the
# agent, which for a GUI-launched editor or a shell without nvm/asdf initialised is not this
# one -- and the hook would then fail silently, being fail-open.
NODE="$(command -v "$NODE")"

supports_ts() {
  "$NODE" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18) ? 0 : 1);
  '
}

ts_required() {
  echo "$1 is TypeScript, which needs Node >= 22.18 or >= 23.6 to run directly." >&2
  echo "  This is $("$NODE" -e 'process.stdout.write(process.versions.node)'). Build and register the compiled hook instead:" >&2
  echo "  cd $HERE && npm install && npm run build && ./install.sh --$platform --dist" >&2
  exit 1
}

hook=""
if [ "$mode" = "install" ]; then
  case "$entry" in
    dist) hook="$HERE/dist/otel-genai-hook.js" ;;
    source)
      hook="$HERE/src/otel-genai-hook.ts"
      # --source used to skip this check that `auto` performs, happily registering a hook
      # this Node could never run.
      supports_ts || ts_required "$hook"
      ;;
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
CODEX_TEMPLATE="$HERE/hooks/codex.json" CLAUDE_TEMPLATE="$HERE/hooks/claude.json" \
KIRO_TEMPLATE="$HERE/hooks/kiro.json" NODE_COMMAND="$NODE" HOOK_PATH="$hook" \
DRY_RUN="$dry_run" \
"$NODE" <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const mode = process.env.MODE;
const platform = process.env.PLATFORM;
const dryRun = process.env.DRY_RUN === "1";
const marker = "otel-genai-hook";

/**
 * Whether a hook entry is one of ours.
 *
 * There is no field to tag entries with -- both Claude Code and Kiro CLI own their config
 * schema -- so this matches on the command. Requiring `--runtime=` alongside the file name
 * keeps it from deleting an unrelated user hook that merely mentions this project, e.g. a
 * wrapper script named after it. A hook file renamed by hand is still not recognized.
 */
const ours = (command) => {
  const text = String(command ?? "");
  return text.includes(marker) && text.includes("--runtime=");
};

/** Writes JSON through a temp file, so an interrupted run cannot truncate a live config. */
const writeJson = (file, value) => {
  if (dryRun) {
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
};

/**
 * Keeps one copy of the file as it was before this script first touched it. Copying on every
 * run would overwrite that with an already-patched version, leaving nothing to go back to.
 */
const backup = (file) => {
  if (dryRun) {
    return;
  }
  try {
    fs.copyFileSync(file, `${file}.bak`, fs.constants.COPYFILE_EXCL);
  } catch {
    // A .bak already exists; it is older and therefore the more useful one.
  }
};

/**
 * Fills in __HOOK_COMMAND__ on the parsed template rather than on its serialized text.
 * Substituting into the JSON source injected the path into a string literal unescaped, so a
 * checkout path containing a quote or a backslash produced invalid JSON.
 */
const substituted = (value, command) => {
  if (typeof value === "string") {
    return value.replaceAll("__HOOK_COMMAND__", command);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituted(item, command));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituted(item, command)]),
    );
  }
  return value;
};

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
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text) || {};
  } catch {
    console.error(`${file} is not valid JSON; fix or move it first`);
    process.exit(1);
  }
};

/** The hooks map of a template, validated up front so a bad template fails before any write. */
const templateHooks = (file) => {
  const hooks = readJson(file).hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    console.error(`${file} has no "hooks" object`);
    process.exit(1);
  }
  return hooks;
};

/**
 * Kiro CLI declares hooks inside an agent config, as
 * `{"hooks": {"<trigger>": [{"command": ..., "timeout_ms": ...}]}}` — a flatter shape than
 * the Codex / Claude `{"<event>": [{"matcher": ..., "hooks": [...]}]}`, and spread over one
 * file per agent instead of one settings file, so it gets its own pass.
 */
const kiroFiles = () => {
  const directory = process.env.KIRO_TARGET;
  const named = process.env.KIRO_AGENT;
  if (named) {
    return [path.join(directory, `${named}.json`)];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    entries = [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
};

const installKiro = () => {
  const directory = process.env.KIRO_TARGET;
  const files = kiroFiles();
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
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
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
      backup(file);
    }

    const hooks = (config.hooks ??= {});
    let removed = 0;
    for (const trigger of Object.keys(hooks)) {
      const raw = hooks[trigger];
      if (!Array.isArray(raw)) {
        // Not a shape this script wrote, so it is not this script's to rewrite either.
        continue;
      }
      const kept = raw.filter((entry) => !ours(entry?.command));
      removed += raw.length - kept.length;
      if (kept.length > 0) {
        hooks[trigger] = kept;
      } else {
        delete hooks[trigger];
      }
    }

    if (mode === "install") {
      const command = commandFor("kiro");
      for (const [trigger, entries] of Object.entries(templateHooks(process.env.KIRO_TEMPLATE))) {
        for (const raw of entries) {
          (hooks[trigger] ??= []).push(substituted(raw, command));
        }
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete config.hooks;
    }

    writeJson(file, config);
    const action = dryRun
      ? "would update"
      : mode === "install"
        ? fresh
          ? "created"
          : "installed"
        : "uninstalled";
    console.log(
      `  ✓ ${action} otel-genai-hook for kiro in ${file} (removed ${removed} stale entries)`,
    );
  }
};

const wantsKiro = platform === "kiro" || platform === "all";

/**
 * Reads every file this run will touch before touching any of them, so a syntax error in one
 * config cannot leave the machine half-configured. readJson / templateHooks exit on a bad
 * file, which is the whole point of doing it here.
 */
const preflight = () => {
  if (wantsKiro) {
    for (const file of kiroFiles()) {
      if (fs.existsSync(file)) {
        readJson(file);
      }
    }
    if (mode === "install") {
      templateHooks(process.env.KIRO_TEMPLATE);
    }
  }
  for (const item of targets) {
    item.exists = fs.existsSync(item.target);
    item.config = item.exists ? readJson(item.target) : {};
    item.templateHooks = mode === "install" ? templateHooks(item.template) : null;
  }
};

preflight();

if (wantsKiro) {
  installKiro();
}

const strip = (entries) => {
  const kept = [];
  for (const entry of entries) {
    const nested = Array.isArray(entry?.hooks) ? entry.hooks : null;
    if (nested === null) {
      // Some other shape; leave it exactly as found.
      kept.push(entry);
      continue;
    }
    const inner = nested.filter(
      (hook) => !ours(hook?.command) && !ours((hook?.args ?? []).join(" ")),
    );
    if (inner.length > 0) {
      entry.hooks = inner;
      kept.push(entry);
    } else if (nested.length === 0) {
      kept.push(entry);
    }
  }
  return kept;
};

const count = (entries) =>
  entries.reduce(
    (total, entry) => total + (Array.isArray(entry?.hooks) ? entry.hooks.length : 0),
    0,
  );

for (const item of targets) {
  const target = item.target;
  if (mode !== "install" && !item.exists) {
    // Uninstalling used to *create* the file it was asked to clean, leaving behind a
    // settings.json containing nothing but an empty hooks object.
    console.log(`  - skipped ${item.runtime}: ${target} does not exist`);
    continue;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const existing = item.config;
  if (item.exists) {
    backup(target);
  }

  const hooks = (existing.hooks ??= {});
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) {
      continue;
    }
    const before = count(hooks[event]);
    hooks[event] = strip(hooks[event]);
    removed += before - count(hooks[event]);
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }

  if (mode === "install") {
    const command = commandFor(item.runtime);
    for (const [event, entries] of Object.entries(item.templateHooks)) {
      for (const raw of entries) {
        const entry = substituted(raw, command);
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
  // Leave no empty `"hooks": {}` behind on uninstall, matching what the Kiro pass does.
  if (Object.keys(hooks).length === 0) {
    delete existing.hooks;
  }

  writeJson(target, existing);
  const action = dryRun ? "would update" : mode === "install" ? "installed" : "uninstalled";
  console.log(
    `  ✓ ${action} otel-genai-hook for ${item.runtime} in ${target} ` +
      `(removed ${removed} stale entries)`,
  );
}
JS

if [ "$dry_run" = "1" ]; then
  echo
  echo "Dry run: nothing was written."
  exit 0
fi

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
