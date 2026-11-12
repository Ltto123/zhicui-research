---
name: literature-review
description: Retrieve, screen and synthesize literature using the workbench's registered evidence tools.
---

Use the current research question and saved checkpoints. Start by inspecting existing evidence and review issues; do not repeat completed discovery or reading merely because the user says to continue.

1. Identify the unresolved scientific question, coverage gap or review issue.
2. When discovery is needed, use the registered search capability and preserve actual query/source diagnostics. Screen titles and abstracts before requesting full text.
3. Read the original source where a factual claim requires it. Distinguish full-text retrieval, completed reading, and claim support. A URL is not evidence that text was read.
4. Keep versions and duplicate reports separate from independent studies. Metadata-only records cannot support empirical claims or meet a minimum-reference requirement.
5. Synthesize by question, population, design and outcome. Prefer explaining agreements, contradictions and applicable conditions to listing papers.
6. Save intermediate findings through the host tools. Use review feedback to choose a targeted next step; retain correct sections and citations.
7. Deliver only after host citation and source gates pass. Keep the workbench's access failures, reading proportions, limits, budgets and review history in the user's collapsible run record. When evidence does not support a claim, narrow or withdraw the claim. Do not turn an operational constraint into a manuscript limitation or a generic disclaimer. Preserve the limitations of the underlying studies and the actual protocol, eligibility criteria and screening results needed for a systematic review. If the scientific subject is a software failure, report what the study observed.

The user reviews the writing outline once before the first draft. After that approval, internal checks, local corrections and delivery proceed automatically; do not ask the user to approve each revision or finished draft. The approved outline is a writing plan, not an exhaustive citation ledger. The host derives body-citation locations without regenerating the outline or pretending that location establishes semantic support.

For isolated problems, use `get_draft` and `patch_draft` with the current draft hash and exact unique original passages. Preserve other text. Reuse a current review; after a small patch, the host reviews affected passages and sources incrementally. Whole-draft rewriting or a new full review is reserved for major changes, changed scientific inputs or an invalid baseline, not every wording correction. Export is a file operation, not another scientific review.

This is a workbench adaptation. Only registered tools are executable; no arbitrary shell, local file or external service access is implied.
