# oc-observational-memory

OpenCode plugin that brings the spirit of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) into OpenCode, within the bounds of OpenCode's plugin API.

This is not a direct port of pi's session-ledger integration because OpenCode plugins do not expose the same custom session-entry append API. It preserves the core idea within each OpenCode session: selected observations, stable reflections, source recall, and compaction-aware memory injection.

Thanks to elpapi42 and the pi-observational-memory contributors for the idea and original implementation.

## Behavior

- Records deterministic observations from user prompts and assistant completions.
- Promotes explicit high-value observations into reflections.
- Stores session-scoped records in `.opencode/observational-memory/memory.json` by default.
- Injects a bounded memory view through `experimental.chat.system.transform`.
- Adds bounded memory to `output.context` during `experimental.session.compacting`.
- Exposes `recall_observation` tool for exact source evidence by memory id.
- Removes a session's memory when OpenCode emits `session.deleted`.

## OpenCode Config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-observational-memory"]
}
```

Local development:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./dist/index.js"]
}
```

Restart OpenCode after changing plugin config or plugin files.

## Options

```json
{
  "plugin": [
    [
      "oc-observational-memory",
      {
        "enabled": true,
        "observeUser": true,
        "observeAssistant": true,
        "inject": true,
        "compactionContext": true,
        "maxInjectedTokens": 1500,
        "maxCompactionContextTokens": 2000,
        "storeDir": ".opencode/observational-memory"
      }
    ]
  ]
}
```

## Scope

This is pi-observational-memory adapted for OpenCode constraints. It is not replacement compaction. It does not summarize the whole transcript. It stores selected session facts and progress records, then lets OpenCode's default compaction continue managing overflow.

Memory is session-local, matching pi-observational-memory's in-session continuity model. Memories from one OpenCode session are not injected into another session, recall is limited to the current session, and `session.deleted` removes that session's stored memory.

## TODO

- Replace regex extraction with memory worker from v3 design for better observation and reflection quality.

## Context Budget

The store keeps all recorded observations, reflections, and sources for sessions that still exist. The rendered context is bounded separately:

- `maxInjectedTokens` limits normal per-turn memory injection.
- `maxCompactionContextTokens` limits memory appended to OpenCode's default compaction prompt.
- Reflections render first.
- Critical and high relevance observations render next, newest first.
- Medium and low relevance observations render only if budget remains.
- Source text stays out of injected context. Use `recall_observation` when exact evidence is needed.
