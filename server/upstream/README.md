# Upstream code used by the research workbench

Source: [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok/tree/6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0),
commit `6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0`.
License: [MIT](./LICENSE), Copyright (c) 2026 K-Dense.

`research-session-runtime.ts` adapts `server/src/agent/session-registry.ts`:
persistent `SessionManager.create/open`, `DefaultResourceLoader`, extension
binding, and the Pi SDK assistant/tool execution loop. This module is used by
the default API research path through `research-harness.ts` and `app.ts`.
It is not an unmodified copy of the whole upstream application.

Workbench-specific boundaries include explicit research tools, selected portable
research skills, total-call accounting, cancellation, same-goal session ownership,
and disabled arbitrary shell/filesystem/extensions. Scientific evidence and
draft records live in the workbench Store; the session JSONL preserves model/tool
conversation history. CLI text-only providers do not offer this tool loop.

`atomic-json.ts`, `canonical-json.ts` and `http-proxy.ts` also originate from
that source and include workbench adaptations. Preserve this attribution and
the accompanying LICENSE when redistributing these portions.

The `research-skills` directory contains portable adaptations of
literature-review 1.11 and citation-management 2.3 from
[K-Dense Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills/tree/a1043ef544e3a100c28e70a736b6cf32554d0677),
and arxiv 1.0.0 from
[Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/arxiv/SKILL.md).
Their explicit MIT declarations, separate copyright holders, complete license
texts, source hashes and provenance limits are retained in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The BYOK license above
does not stand in for their separate notices. The tools expose actual connected
sources, not every database mentioned in an upstream skill.
