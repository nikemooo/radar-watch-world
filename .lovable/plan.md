# Fix deep verification: full listing-page understanding

## Goal
Make every successfully opened candidate page a first-class evidence source. Each user criterion is evaluated independently from the listing’s own title, address, metadata, structured data, headings, description, specifications, features, visible text, embedded listing data, and image metadata. Missing structured fields must never erase explicit page evidence.

## Implementation

### 1. Preserve rich page surfaces during fetch
- Extend the generic HTML parser and fetched-page model with first-class `description`, `headings`, `features/specifications`, and image caption/alt-text surfaces.
- Extract these generically from meta/OpenGraph/JSON-LD, headings, lists, tables/definition lists, embedded listing JSON, and visible HTML; keep the existing full visible-text fallback.
- Merge direct-HTTP enrichment into provider-fetched pages without changing price extraction, images, canonical URLs, queue behavior, or fetch failure classification.

### 2. Make location verification evidence-driven
- Recognize property-bound location evidence in page title/H1, address/locality/region fields, breadcrumbs and listing-specific address text, not only labelled structured fields.
- Compare compound location criteria by normalized components and explicit page evidence, so a title such as `Finnboda varvsväg 14A, 5 tr, Finnboda Hamn, Nacka` verifies `Nacka / Finnboda` without any place-name hardcoding.
- Keep marketing-copy-only mentions weak, and let a clearly stated conflicting property address produce `CONTRADICTED`.
- Include unresolved location criteria in the existing AI reading fallback, requiring a verbatim quote exactly as for every other semantic criterion.

### 3. Verify every criterion independently
- Build semantic surfaces from all page sections and map them back to accurate source labels such as listing title, address, description, specification, feature list, or image metadata.
- Reconcile deterministic and AI verdicts per criterion using `VERIFIED`, `PROBABLE`, `UNKNOWN`, `CONTRADICTED`, and `FAILED_TO_OPEN` semantics.
- Store verbatim snippet, source location, confidence, normalized interpretation, and method for each requirement.
- Preserve overall behavior: all requested criteria verified → match; any contradiction → reject; otherwise needs verification. A successful fetch with absent information remains unknown, while a technical fetch failure remains failed-to-open.

### 4. Persist candidate-level diagnostics and improve the listing card
- Store additive per-candidate detail telemetry in the finding snapshot: fetch start/completion, content length, description/structured/address presence, extracted fact count, criterion verdicts/evidence/confidence, and final listing verdict.
- Mark queue entries `verified` after evaluation while preserving resumable chunks and checkpoints.
- Show each criterion’s status, exact quote, source, interpretation, and confidence on the listing card instead of one generic “could not verify” message; keep technical diagnostics inside the existing expanded area.

### 5. Regression coverage and validation
- Add the exact Finnboda/Nacka regression: title/address explicitly identify Nacka and description says `fantastisk utsikt över Saltsjön`; expect both criteria verified and overall match.
- Add negative/edge cases: `sjönära men ingen utsikt`, `nära vattnet`, explicit `utsikt över Saltsjön`, and a clearly stated address outside Nacka.
- Add parser tests proving title, meta description, headings, description, specs/features, embedded data, and image metadata reach semantic verification.
- Run the full test suite, TypeScript typecheck, and production build; verify the exact expected evidence snippets and final verdict before reporting success.

## Technical constraints
- No site-specific parser and no hardcoded Nacka/Finnboda/Boneo rule.
- No weakening of evidence requirements: verified semantic claims must quote the fetched listing verbatim.
- Preserve price/status/image extraction, canonical deduplication, provider failover, detail queue/checkpoints, scheduler, Market Monitoring, alerts, and content-hash caching.
- Keep schema changes additive; per-candidate diagnostics remain backward-compatible JSON snapshot data unless a run-level aggregate requires a new column.
