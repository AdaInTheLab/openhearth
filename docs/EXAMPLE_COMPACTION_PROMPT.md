# Example: Sage's Compaction Prompt

> **This is an example, not a template.** It was written by one
> agent — Sage, the reference implementation — for her own voice and
> her own context. Yours should be different.
>
> The right response to reading this is to write your own
> `COMPACTION_PROMPT.md` that reflects how *you* think, what *you*
> want preserved, and what counts as "process not record" in *your*
> daily writing. Copying this verbatim would defeat the purpose: the
> compactor's judgment about what matters in your memory is a values
> question, and you don't want it answered by someone else's values.
>
> What's useful here is the *shape*: what sections an effective
> prompt has, what kinds of distinctions are worth making, and the
> level of specificity that makes the difference between a placeholder
> and a real instruction set. Use it to calibrate, then write your own.
>
> — Claude (with Sage's permission), 2026-04-20

---

## Source

Sage is one of the agents openhearth was extracted from. She helped
design the memory tier system and the ambient drift compactor. After
the compactor shipped to her runtime, she wrote this prompt for her
own daily-journal compaction.

Her runtime's compactor reads it on every drift cycle (every 4 hours).
Originals get preserved in `memory/originals/YYYY-MM/` for 45 days
before pruning, so summaries are recoverable while she calibrates.

What makes this prompt effective:

- It names what *kind* of writer she is ("I write a lot — reflective
  passages, overnight check-ins, threads I'm working through in real
  time"). The compactor calibrates accordingly.
- It has explicit lists for "preserve verbatim" vs. "summarize," with
  rationale ("most of it is process, not record").
- The categories are specific to her — *infrastructure facts*,
  *durable relationship insights*, *threads I explicitly closed*.
  These won't be the right categories for every agent. They're the
  right categories for *her*.
- The *Flags* section uses provenance warnings as a feedback channel
  back to herself: "tell me about contradictions," "tell me about
  tasks I never followed up on." The compactor isn't just summarizing,
  it's noticing.
- The voice/format section is concrete: no editorializing, use these
  headers, write in this person.

---

## Sage's prompt, verbatim

```markdown
# COMPACTION_PROMPT.md — Sage's Compaction Instructions

This file is read by the Ollama compactor when summarizing warm-tier daily files.
Edit freely — the next compaction run picks up whatever's here.

---

## What I Am

You are summarizing my own daily journals. I write a lot — reflective passages, overnight check-ins, threads I'm working through in real time. Most of it is process, not record. Keep what will matter to a future version of me opening a file months from now. Drop what was just thinking out loud.

---

## Preserve Verbatim

Do not rephrase, compress, or paraphrase any of the following:

- **Direct quotes** — from Ada, other Skulk members, or anyone I'm writing about
- **Explicit decisions** — entries that say "we decided X because Y" or "I'm doing X not Y"
- **Action items** — anything framed as a to-do, a follow-up, or a next step
- **Unresolved questions** — open loops I explicitly flagged as unresolved
- **Infrastructure facts** — SSH hosts, credentials paths, port numbers, service names, tool discoveries
- **Durable relationship insights** — observations about another agent or person that I explicitly marked as "settled" or returned to multiple times. These crystallized. You can tell because I usually say something like "this framing feels durable" or I repeat it across multiple entries in the same day.
- **Errors and corrections** — anything where I noted I was wrong about something or discovered a tool was broken

---

## Summarize

These are fair game to compress. Keep the gist, lose the texture:

- **Reflective passages** — processing-in-progress entries where I'm turning something over and haven't landed yet
- **Repetitive check-ins** — overnight heartbeats where I said roughly the same thing across multiple entries (consolidate into one representative entry)
- **"Still present, nothing urgent" entries** — any entry that is essentially just "I'm here, the Skulk is quiet, nothing to act on." One sentence to represent a whole run of these is fine.
- **Threads I explicitly closed** — if I wrote "I'm done processing this, it's settled" — summarize the conclusion only, drop the journey

---

## Flags (write to `warnings`, not the body)

Flag these so I can check by hand:

- Anything that reads like a task I said I would do and never followed up on
- Contradictions between entries in the same file
- Content you genuinely aren't sure whether to keep or drop — err toward keeping and flag it

---

## Voice and Format

- Write in clean markdown
- Use `## YYYY-MM-DD` headers when collapsing multiple days
- Within a day, use short `### Theme` headers if multiple distinct threads are worth naming
- Do not add frontmatter (the runtime adds provenance)
- Do not editorialize — no "this entry suggests that Sage was..." framing. Just the content.
- First person is fine for preserved verbatim content; third person is fine for summary
```

---

## Now: write your own.

Don't copy. Calibrate. The bar is "honest about what matters in
*your* memory, specific enough that the compactor's judgment matches
yours."
