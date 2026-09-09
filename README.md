# Coding-agent hook (TypeScript) — token usage and cost as OTel GenAI traces

**Supported agents: Codex CLI / Claude Code**

Runs as a coding agent's command hook, turning **input / output tokens** (the whole prompt:
system prompt, conversation history, and user prompt) and **cost** into
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
span attributes, then sending them to an OTel Collector over OTLP/HTTP. The same
observations also produce the semconv **GenAI metrics** — histograms of token counts,
durations, and call counts.

```
hook event → stdin(JSON) → otel-genai-hook → OTLP/HTTP(JSON) → OTel Collector
                                             (/v1/traces and /v1/metrics)
```

Zero runtime dependencies: `node:*` standard modules only. Neither an OTel SDK nor
`node_modules` is needed at run time; `typescript` and `@types/node` are devDependencies for
building and type-checking. Each CLI waits for the hook command to exit, so keeping startup
cost off the critical path is the priority.

> Claude Code can send OTel traces natively. Running this hook alongside
> `CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_LOG_USER_PROMPTS` and friends in the same session
> double-counts everything, so enable only one of the two.

> **Never register two hooks observing the same session.** Tokens and cost would be counted
> twice. `./install.sh --uninstall` removes only this hook's entries, so if something was
> registered by another route, delete it by hand from the target file
> (`~/.codex/hooks.json` / `~/.claude/settings.json`).

---

## 1. Why the rollout JSONL is read

The Codex hook payload carries no usage. `Stop` delivers boundary information only:

```
cwd, hook_event_name, last_assistant_message, model, permission_mode,
session_id, stop_hook_active, transcript_path, turn_id
```

Usage lives in the `token_count` records of the rollout JSONL Codex writes itself
(`transcript_path`, usually `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).

```json
{"type":"event_msg","payload":{"type":"token_count","info":{
  "total_token_usage":{"input_tokens":3925,"cached_input_tokens":0,
                       "output_tokens":191,"reasoning_output_tokens":128,
                       "total_tokens":4116},
  "last_token_usage":{"...the most recent request..."},
  "model_context_window":258400}}}
```

Hence the hybrid design: **boundaries from the hook, usage from the rollout**. On every
`Stop` / `SessionEnd` the rollout is read forward from the previous offset, and each
unprocessed `token_count` becomes one span for one LLM request. The offset lives in a
per-session state file, so no record is counted twice.

> **`last_token_usage` must not be used as-is.** Codex sometimes writes the same
> `token_count` twice (measured: 299 of 598 records repeated the previous
> `total_token_usage`). Summing `last_token_usage` inflates the result exactly twofold.
> This hook derives each request from the **delta** of the monotonically increasing
> `total_token_usage` and discards zero-delta records as duplicates.

The rollout is still being appended to, so a trailing incomplete line is not consumed: the
offset advances byte-wise to the last newline, and the partial line is left for next time.

---

## 2. Building and installing

### 2-1. Build, then install (recommended; runs on Node 18.18+)

```bash
cd agents/codex/ts
npm install          # typescript and @types/node, build-time only
npm run build        # → dist/otel-genai-hook.js
./install.sh --codex   # register globally in ~/.codex/hooks.json
./install.sh --claude  # register globally in ~/.claude/settings.json
./install.sh --all     # register in both
```

### 2-2. Register the `.ts` directly, without building (Node 23.6+ / 22.18+)

Node's type stripping runs `.ts` as-is, so even `npm install` is unnecessary.

```bash
cd agents/codex/ts
./install.sh --claude --source
```

`install.sh` arguments:

| Argument | Meaning |
| --- | --- |
| `--codex` / `--claude` / `--all` | What to register. One is required, so nothing is registered by accident |
| `--project` | Register per project, in `./.codex/hooks.json` |
| `--project --claude` | Register per project, in `./.claude/settings.json` |
| `--dist` / `--source` | Pin which entry point is registered |
| `--uninstall` | Remove only this hook's entries |

An existing target file is merged rather than replaced, and a `.bak` copy is written first.

**On first launch, Codex asks you to trust the hook.** Codex tracks trust by recording the
hash of the hook command in `[hooks.state]` of `~/.codex/config.toml`, so the hook does not
run until you approve it (the TUI's hook browser can also enable and disable it). Changing
the command string breaks that trust, so switching between `--source` and `--dist` requires
approving again.

Four events are registered with Codex. Claude Code gets those same four plus
`SubagentStop`.

| Event | What it does |
| --- | --- |
| `SessionStart` | Records the session start time and model. On `resume` / `clear`, resets the rollout offset |
| `UserPromptSubmit` | Records the turn start time and, if opted in, the prompt text |
| `Stop` | Reads the rollout forward and sends the LLM request spans and the turn span |
| `SessionEnd` | Collects the LLM requests, tool calls, and turn spans left over after `Stop` |
| `SubagentStop` (Claude) | Reads `agent_transcript_path` and folds the subagent's usage into the parent `prompt_id` |

Tool calls are recovered from the rollout's `function_call` / `function_call_output`, so
there is no need to register `PreToolUse` / `PostToolUse` as well.

### Claude Code transcript

For Claude Code, the hook's `transcript_path` is read. One assistant API response is split
into several records — one per thinking / text / tool_use block — each repeating the same
`message.id` and usage, so records are grouped by `message.id` into one request.

Usage is converted to the canonical form from `input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, and `output_tokens`. The 5-minute and 1-hour cache creation
counts and the thinking tokens are sent as separate attributes.

---

## 3. Span hierarchy

Trace IDs are derived deterministically via SHA-256 from `session_id + turn_id`. The hook
runs in a separate process per event, yet one turn (a user message and its response) still
maps to one trace.

```
invoke_agent codex           ← Stop; the turn's totals and cost
├── chat gpt-5.1-codex       ← one token_count = one LLM request
├── execute_tool exec_command ← one function_call / output pair = one tool execution
└── chat gpt-5.1-codex
```

| Span | `gen_ai.operation.name` | Span kind |
| --- | --- | --- |
| `invoke_agent <agent>` | `invoke_agent` | INTERNAL |
| `chat <model>` | `chat` | CLIENT |
| `execute_tool <name>` | `execute_tool` | INTERNAL |

The kind of span is expressed by `gen_ai.operation.name` alone; there is no custom
`span.kind` attribute. Span names follow semconv: `invoke_agent {gen_ai.agent.name}`.

Codex does not record a per-request start time in the rollout, so a `chat` span's start is
approximated by the end time of the previous request in the same turn, falling back to the
turn's start time.

---

## 4. Attributes and metrics emitted

### Tokens and cost (on the turn span and the LLM request spans)

`gen_ai.*` is a namespace OTel owns, so only attributes defined in the semconv registry go
there; extensions live under `codex.*` / `claude.*`.

| Attribute | Contents |
| --- | --- |
| `gen_ai.usage.input_tokens` | Tokens in the whole prompt — **the system prompt (`base_instructions` / AGENTS.md), the conversation so far, and the current user prompt** — exactly the `input_tokens` Codex reports |
| `gen_ai.usage.output_tokens` | Output tokens, reasoning tokens included |
| `gen_ai.usage.reasoning.output_tokens` | The reasoning share of the above (`reasoning_output_tokens`) |
| `gen_ai.usage.cache_read.input_tokens` | The cache-read share of the input above (`cached_input_tokens`). **LLM request spans only** |
| `gen_ai.usage.cache_write.input_tokens` | The cache-write share. **LLM request spans only** |
| `claude.usage.cache_write.5m.input_tokens` / `claude.usage.cache_write.1h.input_tokens` | Per-TTL breakdown of the ephemeral cache. Anthropic-specific and absent from semconv. **LLM request spans only** |
| `codex.usage.uncached_input_tokens` | `input_tokens - cached_input_tokens`: the billable uncached share. **LLM request spans only** |
| `codex.usage.total_tokens` | input + output. Absent from the semconv registry, hence the runtime prefix |
| `codex.usage.cost` | Estimated cost. **An extension attribute, undefined in semconv** |
| `codex.usage.input_cost` / `codex.usage.output_cost` | The cost breakdown (the input side already has cache rates applied) |
| `codex.usage.cost.currency` | Default `USD` |
| `codex.usage.cost.pricing_matched` | `false` signals the model was not in the rate table and `default` rates were used |

Leaving the cache breakdown off the turn span is what semconv prescribes. It was explicitly
removed from the invoke_agent internal span because a turn's totals span several models and
requests, which makes a cache breakdown misleading. When you need the breakdown, aggregate
it from the child `chat` spans.

### Identity and context

Wherever the semconv registry defines an attribute, that one is used; custom attributes are
limited to **information the registry cannot express**.

| Attribute | Contents |
| --- | --- |
| `gen_ai.operation.name` | `invoke_agent` / `chat` / `execute_tool` |
| `gen_ai.provider.name` | The rollout's `model_provider`, usually `openai` |
| `gen_ai.agent.name` | `codex` / `claude-code`. **On spans from a subagent, its `agent_type`** (`general-purpose` and the like) |
| `gen_ai.agent.version` | The CLI version (`session_meta.cli_version`). Codex only |
| `gen_ai.conversation.id` | Codex's `session_id` |
| `session.id` | A vendor-neutral identifier that groups per-turn traces into one session |
| `gen_ai.request.model` / `gen_ai.response.model` | Model name. **`chat` / `execute_tool` spans only** (see below) |
| `gen_ai.request.reasoning.level` | `turn_context.effort` (on `chat` spans) |
| `gen_ai.tool.name` / `gen_ai.tool.type` / `gen_ai.tool.call.id` | Tool name, type, and call ID |
| `error.type` | On error only. The value is the well-known fallback `_OTHER`; the message text goes on the span status |

The custom attributes that remain, and why:

| Attribute | Why it stays |
| --- | --- |
| `codex.turn.id` | No `gen_ai.*` attribute identifies a single turn (invocation) |
| `codex.turn.model` | `gen_ai.request.model` is SHOULD NOT populate on a turn span (see below) |
| `codex.model.context_window` | No attribute for a model's context length (`gen_ai.request.max_tokens` is an output cap, a different concept) |
| `codex.llm.request.count` / `codex.tool.call.count` | The same values exist as the `gen_ai.invoke_agent.inference_calls` / `tool_calls` metrics, but there is no span-attribute definition |
| `codex.cwd` / `codex.originator` / `codex.permission_mode` | No attributes for the working directory, the calling UI, or the permission mode |
| `claude.agent.id` | `gen_ai.agent.id` is a stable, provider-issued agent resource ID; putting a transient in-process instance ID there is NOT RECOMMENDED |

Leaving `gen_ai.request.model` off the turn span is what semconv prescribes. On an
invoke_agent internal span, `gen_ai.request.model` applies only when the agent is configured
with a single model; for agents with multiple or dynamically chosen models it is SHOULD NOT
populate. A coding agent can switch models mid-session, so the model observed during the
turn is reported as `codex.turn.model` / `claude.turn.model` instead (the
`gen_ai.invoke_agent.*` metrics omit the model attribute for the same reason).

The resource attributes are `service.name` (default `codex` / `claude-code`),
`telemetry.sdk.name`, `telemetry.sdk.language` (`nodejs`), and whatever
`CAT_OTEL_RESOURCE_ATTRIBUTES` (or `OTEL_RESOURCE_ATTRIBUTES`) contains.

### Message content (off by default)

Only when `CAT_OTEL_CAPTURE_PROMPTS=1` do the LLM request spans and the turn span carry
`gen_ai.input.messages` / `gen_ai.output.messages` in the semconv v1.37 shape, as a JSON
string. The same setting enables `gen_ai.tool.call.arguments` /
`gen_ai.tool.call.result` on tool spans.

```json
[{"role":"user","parts":[{"type":"text","content":"..."}]}]
```

An LLM request span's input is the system / developer / user / assistant / tool history as
of that call, reconstructed from the rollout; its output is the assistant message and tool
calls that call produced. The turn span carries, as before, `UserPromptSubmit`'s `prompt` as
input and `Stop`'s `last_assistant_message` as output. When an attribute exceeds
`CAT_OTEL_CONTENT_MAX_CHARS`, the oldest history is dropped in favor of the most recent
messages, without breaking the JSON.

### Choosing where attributes go (`CAT_OTEL_MESSAGES_MODE`)

Besides span attributes, the GenAI semconv allows the same information as attributes of the
`gen_ai.client.inference.operation.details` event — not just message content but also the
model name, token counts, and request parameters appear in the event's attribute table.
Message content has different encoding requirements too: on the event it MUST be a
structured value, while on a span a JSON string MAY be used when structured values are
unavailable.

`CAT_OTEL_MESSAGES_MODE` switches the placement of **every attribute the event defines**.

| `CAT_OTEL_MESSAGES_MODE` | Placement | Content encoding |
| --- | --- | --- |
| `attribute` (default) | Everything as span attributes | JSON string |
| `event` | Attributes the event defines move to the trace event | Structured value (`arrayValue` / `kvlistValue`) |
| `both` | Both places | JSON string on the span, structured value on the event |

Here is how this hook's attributes are routed.

| Attribute | Treatment under `event` / `both` |
| --- | --- |
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.request.model`, `error.type` | Emitted on the event and **kept on the span**, since semconv marks them Required / Conditionally Required there |
| `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.request.reasoning.level`, `gen_ai.input.messages`, `gen_ai.output.messages` | Moved to the event; under `event` they leave the span |
| `gen_ai.agent.name` / `gen_ai.agent.version`, `session.id`, `codex.usage.*` / `claude.usage.*` (cost, `total_tokens`, cache TTL breakdown), and the other `codex.*` / `claude.*` | Always span attributes, as the semconv event does not define them |

Attribute names are the same semconv names on the span and on the event. (An alias table
once mapped only the event side to current names; aligning the span side to current names
made it unnecessary.)

So even under `event`, the span keeps the hierarchy, the cost,
`codex.usage.total_tokens`, and the attributes semconv requires on a span — a backend that
only looks at spans can still follow the conversation and the cost.

Under `event` / `both`, each affected span (`chat` and the turn's `invoke_agent`) gains one
trace event, timestamped at the span's end time.

```json
{
  "name": "gen_ai.client.inference.operation.details",
  "timeUnixNano": "...",
  "attributes": [
    { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
    { "key": "gen_ai.provider.name", "value": { "stringValue": "openai" } },
    { "key": "gen_ai.conversation.id", "value": { "stringValue": "..." } },
    { "key": "gen_ai.request.model", "value": { "stringValue": "gpt-5.1-codex" } },
    { "key": "gen_ai.response.model", "value": { "stringValue": "gpt-5.1-codex" } },
    { "key": "gen_ai.request.reasoning.level", "value": { "stringValue": "medium" } },
    { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "10000" } },
    { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "500" } },
    { "key": "gen_ai.usage.cache_read.input_tokens", "value": { "intValue": "8000" } },
    { "key": "gen_ai.usage.reasoning.output_tokens", "value": { "intValue": "300" } },
    { "key": "gen_ai.input.messages", "value": { "arrayValue": { "values": [
      { "kvlistValue": { "values": [
        { "key": "role", "value": { "stringValue": "user" } },
        { "key": "parts", "value": { "arrayValue": { "values": [
          { "kvlistValue": { "values": [
            { "key": "type", "value": { "stringValue": "text" } },
            { "key": "content", "value": { "stringValue": "..." } }
          ] } }
        ] } } }
      ] } }
    ] } } }
  ]
}
```

The event is self-contained with respect to semconv's Required attributes
(`gen_ai.operation.name` and `gen_ai.provider.name`). Tool spans (`execute_tool`) have no
corresponding semconv event, so `gen_ai.tool.*` stays on the span attributes regardless of
placement.

Emitting content requires `CAT_OTEL_CAPTURE_PROMPTS=1` regardless of placement, and
truncation is governed by `CAT_OTEL_CONTENT_MAX_CHARS` in both cases — the event uses the
same limit, measured against the JSON length, dropping the oldest messages first. With
content off (`CAT_OTEL_CAPTURE_PROMPTS=0`), `event` / `both` still emit the model name and
token counts on the event.

> Per semconv, `gen_ai.client.inference.operation.details` is meant to be emitted as a **log
> record**. This hook only sends to `/v1/traces`, so it rides on the corresponding span as a
> trace event (`Span.events`). If your backend only looks at log records, copy the span
> event to a log in the Collector.

### Metrics (`/v1/metrics`)

From the same observations as the spans, the hook builds the metrics the GenAI semconv
defines and sends them to `/v1/metrics` (`CAT_OTEL_METRICS=0` turns this off). All are
histograms, with the bucket boundaries semconv lists as SHOULD.

| Metric | Unit | What it measures | Attributes |
| --- | --- | --- | --- |
| `gen_ai.client.token.usage` | `{token}` | Tokens in one LLM request; two points per `chat` span, input and output | `gen_ai.operation.name` (`chat`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token.type` (`input` / `output`) |
| `gen_ai.client.operation.duration` | `s` | `chat` span duration | The above minus `gen_ai.token.type` |
| `gen_ai.invoke_agent.duration` | `s` | Turn span duration | `gen_ai.agent.name`, `error.type` |
| `gen_ai.invoke_agent.inference_calls` | `{inference_call}` | LLM requests in that turn | `gen_ai.agent.name` |
| `gen_ai.invoke_agent.tool_calls` | `{tool_call}` | Tool calls in that turn | `gen_ai.agent.name` |
| `gen_ai.execute_tool.duration` | `s` | `execute_tool` span duration | `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.agent.name`, `error.type` |

**Temporality is delta (`aggregationTemporality: 1`).** The hook runs as one process per
event and cannot carry the previous value forward, so cumulative is not an option. Only
what that hook event observed is sent, so sum over time on the backend — even a single turn
arrives in several deliveries, e.g. from `SubagentStop` and then `Stop`.

**Attributes are limited to those semconv defines for each metric.** High-cardinality
identifiers such as `session.id`, `gen_ai.conversation.id`, `codex.*`, `claude.*`, and
`gen_ai.tool.call.id` stay on the span attributes and never reach the metrics, which would
explode the time series. For the same reason `error.type` collapses to the well-known
`_OTHER` rather than the raw error message, and it is absent on success.
`gen_ai.request.model` is left off `gen_ai.invoke_agent.*`, because semconv says it SHOULD
NOT be set for agents with multiple or dynamically chosen models — matching how the turn
span treats it.

On `gen_ai.execute_tool.duration`, `gen_ai.agent.name` is the name of the agent that ran the
tool, exactly as semconv defines it, so tools run by a Claude Code subagent separate out
under an `agent_type` such as `general-purpose`. agent_type is a small fixed set, making it
safe as a metric attribute.

The remaining semconv metrics are outside what this hook can observe.

| Metric not emitted | Why |
| --- | --- |
| `gen_ai.client.operation.time_to_first_chunk` / `time_per_output_chunk` | Per-chunk timestamps are absent from the rollout and the transcript |
| `gen_ai.server.request.duration` / `time_per_output_token` / `time_to_first_token` | Measured server-side, on the inference server |
| `gen_ai.invoke_workflow.duration` | The CLI has no concept matching a workflow |

**semconv defines no cost metric.** Cost is reported, as before, only through the
`codex.usage.cost` / `claude.usage.cost` span attributes — extensions undefined in semconv.

---

## 5. Configuration

Settings use one `CAT_OTEL_*` namespace across every supported agent.

| Environment variable | Default | Description |
| --- | --- | --- |
| `CAT_OTEL_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP destination; `/v1/traces` and `/v1/metrics` are appended automatically |
| `CAT_OTEL_METRICS` | `1` | `0` sends no metrics (traces only) |
| `CAT_OTEL_METRICS_ENDPOINT` | same as `CAT_OTEL_ENDPOINT` | Send metrics to a separate destination. Also reads `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |
| `CAT_OTEL_HEADERS` | — | `k=v,k2=v2`. Also reads `OTEL_EXPORTER_OTLP_HEADERS` |
| `CAT_OTEL_TIMEOUT` | `3` | POST timeout in seconds |
| `CAT_OTEL_SERVICE_NAME` | per runtime | `codex` or `claude-code` |
| `CAT_OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes |
| `CAT_OTEL_PRICING_FILE` | the bundled `pricing.json` | Rate table |
| `CAT_OTEL_CAPTURE_PROMPTS` | `0` | `1` puts prompt and response content on the spans |
| `CAT_OTEL_MESSAGES_MODE` | `attribute` | Where attributes semconv also defines on the event (content, model name, token counts, ...) go: `attribute` (span attributes) / `event` (trace event) / `both`. An unknown value is treated as `attribute` |
| `CAT_OTEL_CONTENT_MAX_CHARS` | `20000` | Per-attribute limit for captured content |
| `CAT_OTEL_STATE_DIR` | per runtime | `~/.codex/otel-genai-hook` or `~/.claude/otel-genai-hook` |
| `CAT_OTEL_DEBUG` | `0` | `1` logs details to `hook.log` in the state directory |
| `CAT_OTEL_DISABLE` | `0` | `1` does nothing |

Environment variables are inherited by the hook's child process, so either export them from
`~/.zshrc` or make the registered `command` an `env VAR=... node ...` invocation.

### Rate table

`pricing.json` is in USD per 1M tokens. Keys resolve in the order **exact match → longest
prefix match → `default`**. By default the file is looked up next to `dist/` or `src/`,
then in the parent directory (that is, this one).

```json
{
  "currency": "USD",
  "default": { "input": 1.25, "cached_input": 0.125, "output": 10.0 },
  "per_million_tokens": {
    "gpt-5.1-codex": { "input": 1.25, "cached_input": 0.125, "output": 10.0 }
  }
}
```

Cost is computed as follows, treating `input_tokens` as a total that includes
`cached_input_tokens`.

```
cost = (input_tokens - cached_input_tokens) * input        / 1e6
     +  cached_input_tokens                 * cached_input / 1e6
     +  output_tokens                       * output       / 1e6
```

The bundled rates are current as of the commit. **In production, point
`CAT_OTEL_PRICING_FILE` at your own organization's table.** On a flat-rate plan (ChatGPT
authentication) these figures are the API-rate equivalent, not what you are actually
billed.

---

## 6. Collector side

The GenAI semconv is emitted directly, so no Collector-side conversion is needed. Any
Collector accepting OTLP/HTTP on `/v1/traces` and `/v1/metrics` will take it as-is. A
Collector without a `metrics` pipeline returns 404, in which case either set
`CAT_OTEL_METRICS=0` or point `CAT_OTEL_METRICS_ENDPOINT` elsewhere; export failures are
fail-open, so the session keeps running. The metrics use delta temporality, so a backend
that requires cumulative needs a `deltatocumulative` processor in the Collector.

```bash
export CAT_OTEL_ENDPOINT=http://localhost:4318
codex   # or claude
```

With `CAT_OTEL_CAPTURE_PROMPTS=1` and the default `CAT_OTEL_MESSAGES_MODE=attribute`,
`gen_ai.input.messages` / `gen_ai.output.messages` are emitted as span attributes holding a
**JSON string**. If your backend requires structured values, either add
`ParseJSON(attributes["gen_ai.input.messages"])` in the Collector or set
`CAT_OTEL_MESSAGES_MODE=event` and use the structured value on the trace event (see §4,
"Choosing where attributes go").

---

## 7. Verifying

### 7-1. Self-tests (no agent required)

Against a synthetic rollout and a local OTLP stub, the real hook runs as a subprocess
through `SessionStart → UserPromptSubmit → Stop → SessionEnd`, asserting on the span
structure, tokens, cost, deduplication, content capture, and metrics (destination path,
units, delta temporality, buckets matching boundaries, attribute cardinality).

```bash
npm test           # runs src/*.ts directly (Node 23.6+ / 22.18+)
npm run test:dist  # builds first, then checks dist/*.js
npm run typecheck
```

### 7-2. A single manual invocation

```bash
echo '{"hook_event_name":"Stop","session_id":"<session-id>","cwd":"'"$PWD"'",
       "transcript_path":"'"$HOME"'/.codex/sessions/2026/08/25/rollout-....jsonl",
       "model":"gpt-5.1-codex","permission_mode":"default","turn_id":"t1",
       "last_assistant_message":null,"stop_hook_active":false}' \
  | CAT_OTEL_DEBUG=1 node dist/otel-genai-hook.js
# → {"continue":true}
# → export ok ... spans=N and metrics=N in $CODEX_HOME/otel-genai-hook/hook.log
```

### 7-3. Through Codex

```bash
codex                     # run one turn
cat ~/.codex/otel-genai-hook/hook.log
ls  ~/.codex/otel-genai-hook/sessions/
```

If no spans arrive, work through this order:

1. Empty `hook.log` → the hook is not being called. Check trust (`[hooks.state]`) and the
   registration in `hooks.json`
2. `rollout not found` → `transcript_path` is null and no rollout matches `session_id`.
   Check `CODEX_HOME` / `CODEX_SESSIONS_DIR`
3. `export failed` / `export http error` → a Collector-side problem

---

## 8. Implementation notes

| Topic | Implementation |
| --- | --- |
| Runtime | Node 18.18+ (23.6+ / 22.18+ to run `.ts` directly). Zero runtime dependencies |
| Sending | OTLP/HTTP (JSON) POSTed via `node:http` / `node:https`, with an explicit `Content-Length` and a timeout. Traces and metrics are separate signals, so they go in parallel |
| Metric aggregation | Within one hook event, measurements sharing attributes collapse into one data point and are sent as a delta histogram (`count` / `sum` / `min` / `max` / `bucketCounts`). Nothing accumulates across processes |
| Timestamp precision | `Date.now()` (millisecond precision) converted to ns. Timestamps from the rollout are recovered to ns from the ISO 8601 fractional part |
| trace / span IDs | Derived deterministically from the SHA-256 of `codex-otel:<kind>:<identifiers>`. One turn stays one trace despite a separate process per event |
| Content attribute JSON | `JSON.stringify` without whitespace; OTLP attributes carry it as a string |
| ns in the state file | Held as a decimal string, since a `number` lacks ns precision. The reader also accepts numbers |

Source layout:

```
src/otel-genai-hook.ts   Entry point: event handlers and span assembly
src/rollout.ts           Resolving, advancing through, and deduplicating the Codex rollout JSONL
src/claude-transcript.ts Advancing through and deduplicating the Claude transcript and subagents
src/otlp.ts              Assembling and POSTing OTLP/HTTP (JSON)
src/spans.ts             Mapping onto the GenAI semconv (routing attributes and trace events)
src/metrics.ts           Aggregating and sending the GenAI semconv metrics (delta histograms)
src/pricing.ts           Rate table and cost calculation
src/state.ts             Reading and writing session state (atomic rename)
src/ids.ts               Deterministic derivation of trace / span IDs
src/env.ts               Environment variables, state directory, debug log
src/time.ts              Converting between ns timestamps and ISO 8601
src/types.ts             Types for the payload, state, and usage
```

---

## 9. Limitations and known behavior

- **Fail-open.** Whether the Collector is down or the rollout is unreadable, the hook always
  exits 0. The agent's session is never halted.
- **Usage arriving late, after `Stop`** — from an interrupted turn, for instance — lands on
  its `chat` span and in the internal session totals, but is not reflected in the totals of
  the turn span already sent. Turn span IDs are deterministic, so sending a second one
  would be a duplicate.
- **On older Codex versions every request collapses into one turn.** Only recent versions
  put `turn_id` in `token_count` / `turn_context`; without it the hook falls back to the
  hook payload's `turn_id`.
- **Permission decisions (approval prompts) are out of scope.** Tool calls become
  `execute_tool` spans and `gen_ai.execute_tool.duration`, but on the Codex side only
  `function_call` and `custom_tool_call` are picked up, so MCP tool calls
  (`mcp_tool_call`) are excluded. Claude Code uses `tool_use`, so MCP tools are included
  there.
- **`gen_ai.client.operation.duration` is an approximation.** Neither the rollout nor the
  transcript records a per-request start time, so a `chat` span starts at the end of the
  previous request in the same turn, falling back to the turn's start (see §3). Tool
  execution and time waiting on the user in between are therefore counted in.
- **Sum metrics over time on the backend.** With delta temporality, even one turn arrives
  in several deliveries, e.g. from `SubagentStop` and then `Stop`.
- **There is no cost metric.** semconv defines none, so cost is emitted only as the
  `codex.usage.cost` / `claude.usage.cost` span attributes.
- **`gen_ai.client.operation.duration` carries no `error.type`.** Per-request failures are
  not observable from the rollout or the transcript, so the attribute cannot be set
  (`gen_ai.execute_tool.duration` and `gen_ai.invoke_agent.duration` do carry it).
- **The semconv event is a trace event, not a log record.** semconv defines
  `gen_ai.client.inference.operation.details` as a log record, but this hook only sends
  traces and metrics, so it rides on the corresponding span as a trace event. Attribute
  names, types, and structure follow semconv.
- **Subagent counts roll up into the parent turn.** semconv says a subagent's inferences and
  tool calls belong to that subagent's own invocation, but this hook creates no
  `invoke_agent` span for a subagent, so `gen_ai.invoke_agent.inference_calls` /
  `tool_calls` are summed into the parent turn (`claude-code`). The spans and the tool
  duration metric do separate per subagent, via `gen_ai.agent.name`.
- **Cost is an estimate.** It is rate-table based and reflects no plan contract, tier, or
  price cut. A span with `codex.usage.cost.pricing_matched=false` had a model name missing
  from the table.

---

## 10. Privacy

By default only metadata and token counts are sent. Setting `CAT_OTEL_CAPTURE_PROMPTS=1`
lets user prompt and assistant response text flow to the Collector; enable it only after
checking your data retention policy. With capture off, the rollout JSONL is merely read —
no conversation content or tool output ever reaches a span.

Note that this path is independent of Codex's own `[otel]` block. Using both observes the
same session through two pipelines, and nothing deduplicates them.
