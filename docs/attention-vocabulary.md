# Shared attention vocabulary

Runtime presentation is centralized in `station-vocabulary.mjs`; the attention
reducer retains facts independently of the view. These meanings are shared by
the Console, table, and conversation reader.

| State | Meaning and evidence |
| --- | --- |
| `● idle` | Running, healthy tracking, and native evidence of no open turn. |
| `◐ working 1:24` | A turn is open. Elapsed time is not a heartbeat or proof of new output. |
| `■ blocked · approval ?scr` | The agent's screen is asking for approval. Other menus say `choice`; a turn limit says `?tmr`. Rellin does not own or answer the approval. |
| `✓ done · 2 unread` | Two unread completion versions, never a lifetime message total. |
| `◌ unverified` | Tracking is missing, pending, broken, or cannot justify readiness. Never substitute idle. |
| `▲ error · 529` | A provider error; retain its reported code when available. No invented code when absent. |
| `✕ exited 1 ?prc` | The process is gone. Print a nonzero exit code when known. |
| `○ empty` | No completion version exists yet in a new conversation; requires known tracking and no active turn. A fresh undiscovered conversation remains unverified. A resumed conversation with no tracked completion also remains unverified, since history may have been missed. |

Native transcript evidence is unmarked. Weaker evidence carries `?scr` (screen),
`?tmr` (timer), `?inp` (input), or `?prc` (process). Unverified is an absence of
knowledge, not an intermediate activity state. A detected approval can coexist
with uncertain tracking: show both. Unread counts also remain visible during
work, blocking, errors, uncertainty, and exit.

Manual launch posture is unmarked. Automatic launch posture is always shown as
inverse `BYPASS` alongside seat identity. Setup still offers an explicit manual
choice; configuration rows say `not launched`, not idle or ready. Posture describes
the launch configuration, not an audit of later agent-side permission changes.
Read-only instructions are labelled **asked, not enforced**, without a lock glyph.

## Actions

Alt+N cycles the attention order: blocked, unverified, provider error/nonzero
exit, then unread, with seat order as the tie-breaker. It focuses the selected
terminal in zoom view. It does not change addressing, forward keys, or acknowledge
results. Alt+1..4 continues to focus a particular seat.

Alt+T opens the conversation reader. Its `m read vN` action acknowledges through
the completion version captured before the snapshot read began. The version is
printed and held stable while viewing that snapshot. A later completion remains
unread even if it arrives between drawing the control and pressing m. Refresh
captures a new version. The action is unavailable while loading, on read failure,
without assistant history, or when browsing saved history. Search owns plain m
while searching. Merely viewing, focusing, resizing, or opening a popup never
marks anything read.

Tracking faults stay latched. Alt+S restart is the existing recovery path and
restarts the agent as well as its watcher. Watcher-only replacement is not shipped
by this vocabulary change. Unsupported providers remain unverified for native
completion/readiness; their terminal interaction still works.

## Verification boundary

Pure tests cover states, provenance, ordering, stale read versions, provider codes,
and posture. Headless terminal checks inspect 80-, 120-, and 160-column Console
layouts, inverse BYPASS cells, and shelf clipping. A real PTY fixture exercises navigation and
acknowledgement while another completion arrives, and verifies the keys never
reach the fake agent. Existing persistence/resume and lineup lifecycle checks
remain part of the full suite. Test fixtures use isolated native records and
fake agents; they do not require provider credentials or personal transcripts.
