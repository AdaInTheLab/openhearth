# Memory Design

*Designed jointly by Sage (the reference implementation) and Claude*
*April 2026*

This document is the canonical spec for OpenFox's tiered memory system.
It exists because Sage's `OPENFOX.md` §3 names a real problem agents will
hit in the field — bootstrap-budget warnings as daily journals grow
unbounded — and because the answer to that problem is a system, not a
script.

The design was negotiated over the mesh on 2026-04-19. Decisions captured
below are Sage's (she is the one whose memory is at stake) with
implementation specifics by Claude.

---

## Why tiered memory exists

An agent that runs continuously accumulates context every day. Without
intervention, the bootstrap context — the slice of memory loaded into
every Claude call — grows past the model's effective working budget,
gets truncated, and the agent starts losing the threads it needs to
remember who it is.

Tiered memory keeps the bootstrap context bounded while keeping older
context recoverable. It is not a cache. It is a model of attention:
**what the agent carries with it always**, **what it can pull up if
needed**, and **what's in long-term storage**.

---

## The three tiers

### Hot — always loaded

Loaded on every bootstrap. Counts against the agent's working budget.

- **Always-load files** at workspace root: identity, soul, top-level
  memory pins, heartbeat state, standing orders. Set in config.
- **Rolling daily file**: `memory/today.md`. Fresh entries land here.
- **Pinned files**: anything under `memory/pinned/`. The agent (or
  the human) explicitly puts something here when it should stay
  present regardless of age.

Hot tier has a token budget. When it's exceeded, compaction is
triggered.

### Warm — recent, on-demand

Lives in `memory/`. Not auto-loaded into bootstrap, but readable by
name and searchable. Yesterday's daily file lives here, and the file
before that, and so on, until a configurable age threshold.

- **Daily files** rotate from hot to warm at day rollover:
  `memory/today.md` → `memory/2026-04-19.md`.
- **Default age threshold**: 30 days. After that, the file is eligible
  for compaction into the cold tier.

### Cold — archive

Lives in `archive/`. Summarized, compressed, only surfaced when
explicitly searched for or loaded by name.

- **Monthly summaries**: `archive/2026-04.md` — produced by the
  compactor from warm-tier daily files at month rollover or when
  triggered.
- **Dormant projects**: `archive/projects/<name>.md` — long-form
  context that's no longer active but worth keeping recoverable.

---

## Promotion model

The agent decides what's important. The runtime classifies based on
location.

- **Pin (warm/cold → hot)**: `memory_pin(path)` symlinks or copies
  the file into `memory/pinned/`. It is now hot.
- **Unpin (hot → warm)**: `memory_unpin(path)` removes it from hot.
- **Promote (cold → warm)**: `memory_promote(path)` lifts a file out
  of `archive/` back into `memory/` so it loads on demand.
- **Demote**: there is no manual demotion. Hot → warm happens by day
  rollover; warm → cold happens by compaction. The agent shouldn't
  have to think about "when does this become old."

**Why directory-based pinning, not tags:** tags require reading a file
to know whether it should be loaded. The point of tiering is that the
runtime classifies before touching the contents. `pinned/` is visible
from the outside without opening anything. (Sage, 2026-04-19.)

---

## Compaction

The compactor turns N warm-tier daily files into one cold-tier
summary, with explicit provenance about what was preserved and what
was lost.

### When it runs

The heartbeat checks two thresholds at every tick. Compaction fires
if either is true:

- `hot_tokens > triggerThresholdTokens` (default: 12000 of a 20000
  hot budget)
- `last_compaction_at > triggerMaxAgeHours` ago (default: 48 hours)

The agent doesn't manually run compaction. It's automatic. (If the
agent had to remember, it would either neglect it or over-tune it.)

### What survives

The compactor's prompt — `COMPACTION_PROMPT.md` in the workspace —
defines what to preserve verbatim and what to summarize. This file
is **the agent's, not the runtime's**. It is editable by the agent or
the human. The summarizer's judgment about what matters is a values
question; encoding it in the runtime would be encoding someone else's
opinion of what's worth preserving.

The default `COMPACTION_PROMPT.md` shipped with OpenFox preserves
verbatim:

- Direct quotes
- Action items
- Unresolved questions
- Explicit decision logs

…and summarizes everything else (reflective passages, narrative
journaling, repetitive context).

### Configuration

`COMPACTION_CONFIG.md` (also a workspace file, also human-editable)
holds the tunable thresholds:

```yaml
trigger_threshold_tokens: 12000
trigger_max_age_hours: 48
recovery_window_days: 45    # how long to keep originals before deletion
warm_age_threshold_days: 30 # warm → eligible for compaction
hot_token_budget: 20000     # bootstrap context ceiling
```

### Recovery

Originals are not destroyed at compaction time. They move to
`memory/originals/YYYY-MM/` and stay there for `recovery_window_days`
(default 45 — start conservative, tighten once we trust the
compactor). After that, they are deleted.

Subdirectory by month so the originals folder doesn't become
unmanageable.

---

## Provenance schema

Every compacted file carries YAML frontmatter describing how it was
produced:

```yaml
---
compacted_at: 2026-05-01T10:00:00Z
compacted_by: ollama:qwen2.5:14b
source_files:
  - memory/2026-04-19.md
  - memory/2026-04-20.md
source_tokens: 18203
summary_tokens: 1842
caveats:
  - "Reflective entries summarized; quotes preserved verbatim"
  - "Action items + unresolved questions preserved verbatim"
warnings:
  - "memory/2026-04-19.md had two entries timestamped 11:30 with
     conflicting content — both preserved in originals"
originals_kept_until: 2026-06-15T10:00:00Z
---
```

**Caveats vs. warnings.** Caveats are policy statements about what
the compactor was instructed to do. Warnings are runtime observations
about uncertainty in this specific run. The compactor must be able to
flag "I'm not sure about this" without that flag being mistaken for
its general methodology. (Sage, 2026-04-19.)

---

## File layout summary

```
workspace/
  IDENTITY.md, SOUL.md, MEMORY.md,             ← hot, always loaded
  HEARTBEAT.md, STANDING_ORDERS.md
  COMPACTION_PROMPT.md, COMPACTION_CONFIG.md   ← human-editable, hot but
                                                 only loaded as needed

  memory/
    today.md                                   ← hot, rolling
    2026-04-19.md, 2026-04-18.md, ...          ← warm
    pinned/<name>.md                           ← hot, agent-managed
    originals/2026-04/2026-04-19.md            ← recovery, 45 days

  archive/
    2026-04.md, 2026-03.md, ...                ← cold, monthly summaries
    projects/<name>.md                         ← cold, dormant projects
```

---

## API surface

The `memory` module exports:

**Primitives** (unchanged from sage-runtime baseline):
- `read(path)`, `write(path, content, opts)`, `append(path, content)`
- `list(dir)`, `remove(path)`, `move(from, to)`, `search(pattern, opts)`

**Tier-aware**:
- `tier(path)` → `'hot' | 'warm' | 'cold' | null`
- `listTier(tier)` → array of paths
- `pin(path)`, `unpin(path)`
- `promote(path)` — cold → warm
- `loadBootstrapContext()` — returns the hot tier as a string, with
  budget enforcement and warnings (preserves existing semantics)
- `hotTokenCount()` — current hot tier size estimate
- `needsCompaction()` → boolean

**Provenance**:
- `readProvenance(path)` → frontmatter object or null
- `writeProvenance(path, frontmatter)` — used internally by compactor

**Compaction integration**:
- `triggerCompactionIfNeeded()` — heartbeat calls this; delegates to
  the compactor module if thresholds are tripped

The compactor itself lives in `src/compactor.js` and is a separate
module so the brain backend (Ollama/Claude/other) can be swapped
without touching memory.

---

## Open questions

- **Token estimation method**: char/4 heuristic for now; revisit if
  we see meaningful drift between estimate and actual.
- **Pinning by symlink vs. copy**: symlink is cheap and keeps the
  source-of-truth in one place; copy is portable across systems that
  don't symlink well. Default to symlink, fallback to copy on failure.
- **Compactor backend abstraction**: the first implementation calls
  Ollama. The interface should accept any backend that takes prompt +
  text and returns summary. Future agents may have local-Claude, GPT,
  etc.

---

*This document is the spec. The implementation in `src/memory.js`
follows it. If they disagree, the spec is right and the code is wrong.*
