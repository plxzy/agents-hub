---
description: Show Agents Hub — status, recent runs and what waits for your review (dashboard where supported)
argument-hint: "[agent name or question]"
---

Call the `open_dashboard` tool of the `agents` MCP server. If this host shows MCP App widgets, the dashboard
appears; otherwise give the user a short overview from its summary plus `list_runs` (last 5) and `list_pending`:
which agents ran recently and how it went, anything running now, and what waits for their review (with ids).

If the user added "$ARGUMENTS", focus the overview on that agent or question. Do not rate runs or decide
review items unless the user explicitly tells you to.
