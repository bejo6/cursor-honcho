---
name: honcho-status
description: Read the Honcho briefing already injected into this chat. Do not inspect the plugin or the API key.
disable-model-invocation: true
---

# Honcho status

The cursor-honcho hook injects the user peer's own memory each turn (Hermes/dsh-style). Answer from that briefing.

If the briefing is absent, say the prompt hook did not inject it. Stop.

Do not run shell or `node`. Do not read `node_modules`, plugin source, hook logs, or `config.json`.
