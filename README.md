# Rellin

A shared terminal workbench for your coding agents.

Requires Node.js >=22.6 and a real terminal. Install and sign in to your chosen agent CLIs separately, then:

```powershell
npm install -g rellin
rellin
```

Repeat the install command to update to the latest release. To develop from source, run `npm install`, then `npm start`; `npm link` links the command to your checkout. Run `npm test` for checks.

For packaged releases and installation on another machine, see
[Installing Rellin](docs/installation.md). The `station` command remains a compatibility alias.

Session data stays in `~/.mrmak`; no session data or credentials are included. The legacy data directory is retained for compatibility with existing sessions.

Run `npm start` to configure seats in the Console. Click **Continue session**
above the presets (or press `c`) to open saved sessions. The latest resumable run
in the current folder is preselected there. Escape or **Back to setup** returns
without losing the new lineup. Inside the picker, `p` opens projects, including
pinned and recent folders discovered from Rellin, Claude, and Codex.
Setup, history, and live work share one terminal screen. During slower loads,
a footer spinner names the operation; the previous view stays visible until
the next one is ready. Returning to setup reuses agent options for that folder.

The left shelf starts at 26 columns. Drag its divider to resize it; the chosen
width follows you between views and is saved for the next launch. Setup fields have dropdown
indicators; presets, Add agent, and Start session are clickable buttons. Presets
stack vertically unless the complete set fits on one row. Five-line
seat cards show identity, state with observed activity, detail, and the available
action. The fifth live line is reserved for the separate cache pass. Eight
15-second activity buckets cover two minutes; missing evidence is a dot, never
an activity bar. Short terminals page the shelf around focus.

One work surface shows the focused native terminal, transcript, table Ledger,
or usage. Click a shelf card or use Alt+1..4 to focus; normal typing still goes
directly to that agent. Alt+G returns to the Console. Alt+` toggles the table;
Alt+U shows usage. Focus never marks an answer read.

- `n`: start a new session in the selected project, name it, then choose agents.
- `p`: pin or unpin the selected project; pins persist between launches.
- `/`: search the current list; Enter keeps the filter, Escape clears it.
- `o`: enter a folder path (relative paths and `~` are supported).
- `h`: browse history across all projects.
- `Esc`: cancel editing or go back; `q` or `Ctrl+Q`: quit the picker.

Page Up/Down scroll long lists. Active and legacy runs remain visible, with an
explanation when selected. A missing native transcript leaves the picker open
so you can choose another session. Pins are saved in `station-projects.json`
under the Rellin data directory.

Manage the running lineup with **Alt+S**. A compact popup lets you select a seat
with Up/Down, then:

- `a`: add an installed agent; use Tab/Up/Down to select agent, model, effort,
  or permission mode, Left/Right to change it, and Enter to launch.
- `r`: restart the selected agent; Enter confirms stopping its current turn and
  resuming its saved conversation with the same settings.
- `x`: close the selected seat; Enter confirms. Its conversation stays in history
  as a separate closed-seat entry.
- `Esc`: cancel or return to the agents. Successful actions dismiss the popup.

The other agents keep running. Rellin supports one to four seats; end an active
table discussion and let any handoff or clipboard paste finish before changing
the lineup. Restart checks captured history before stopping the process. If no
conversation ID was captured, the confirmation explicitly offers a fresh chat.
Missing history is an error, never a silent replacement. A failed restart leaves
the seat stopped with its saved identity intact, ready to retry. Surviving seats
keep their names and unread results even when their numbered positions change.

New seats default to **manual** for every agent, including when reusing the last
table or changing the selected agent. Choose **auto** explicitly to opt in.
Claude receives `--permission-mode manual`; Grok receives `--permission-mode
default`; Codex receives workspace-write sandboxing, on-request approvals, and
human approval review. OpenCode starts with auto disabled and an ask fallback.
Manual mode still honors the provider's specific allow/deny rules.

Kimi and Antigravity do not document a per-launch manual override for every
automatic default. Rellin checks their configuration and reports conflicting
defaults before launch, rather than labelling an automatic session manual or
rewriting provider settings. See [Kimi config](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html)
and [Antigravity settings](https://antigravity.google/docs/cli/reference/).
Resuming or restarting an existing seat retains its explicitly saved permission
choice. Reload Rellin to apply launcher changes; running agents retain their
current mode until relaunched.

Read a conversation with **Alt+T** while working, or select a saved run and press
**v** in session history. Viewing saved messages does not launch an agent. The
reader supports Claude, Codex, and Grok when a native conversation ID is known.

- Left/Right: previous/next message; Up/Down and Page Up/Down: scroll the message.
- `/`: filter messages by text; Enter finishes searching, Escape clears a search
  being edited. Home/End selects the first/last matching message.
- `c`: request copying the whole displayed message through the terminal clipboard.
- `f`: choose a file referenced in the displayed message, including saved history.
- Tab: switch seats; `r`: refresh from disk; Escape or `q`: return.

Agent work continues while the reader is open. Reader keys never go to the agent.
This is a text snapshot with manual refresh, loading up to the newest 4 MiB and
1,000 messages (100,000 characters per message); a notice marks limited history.
Search covers that loaded history. Clipboard support depends on the terminal.

Open deliverables with **Alt+O** from an agent pane. The compact Files popup lists
up to 200 local references from that seat's loaded conversation, newest messages
first. It recognizes Markdown links, backtick paths, image references, and
Obsidian-style `[[relative/note]]` links. Relative paths use the Rellin project's
working folder; paths with spaces should use backticks or Markdown links.
Source references such as `file.cpp:42` open the file (line navigation is not yet
implemented). Missing files remain listed with an explanation.

- Arrow keys select a file; **Enter** opens it and dismisses the popup.
- **p** enters a local path when it was not detected or history is unavailable.
- **s** opens routing settings; select a field and press Enter to change it.
- **r** refreshes references; **Esc** returns; **Ctrl+Q** quits Rellin.

Markdown defaults to **auto**: notes in an existing containing Obsidian vault
open in Obsidian; other notes use the configured editor or system application. An optional vault path
restricts automatic Obsidian routing to that vault. **system** always uses the
system association; **obsidian** requires a containing vault. Vaults must already
be opened in Obsidian. Rellin uses its documented
[open-note URI](https://obsidian.md/help/uri), without importing, copying, or
rewriting notes. Vault organization and durable knowledge management remain external to Rellin.

HTML defaults to a browser. On Windows, Rellin resolves the registered HTTP
browser; macOS uses Safari; Linux uses the registered desktop browser through
`xdg-settings` and `gtk-launch`. You can choose a browser executable or use the
HTML **system** route instead. Images, PDFs, and office reports use their default
applications. Source files, scripts, and diffs open as text in the selected editor
(Notepad on Windows, TextEdit on macOS, an available graphical editor on Linux).
Browser/editor overrides are executable paths, not command strings.

Settings persist in `~/.mrmak/station-files.json` (or `RELLIN_HOME`, with `STATION_HOME` supported for compatibility). Launcher
errors stay in the popup so you can correct the route. A successful request means
the application was launched/dispatched; Rellin cannot verify what it displayed.
Markdown remains the format for project knowledge, plans, decisions, and handoffs;
HTML is available for interactive or presentation-oriented deliverables.

**Ctrl+left-click** opens a local file or HTTP(S) link in an agent pane or the
conversation reader. File links use the same Obsidian/browser/editor settings as
the Files picker. Native OSC 8 links retain their hidden destination and are
underlined; visible Markdown links, paths, and web URLs are also recognized.
Normal clicks still focus panes and dragging still copies text. Wrapped terminal
links are resolved against that seat's buffer, including its scrollback. Line
suffixes select the file; editor line navigation remains future work.

With a Rellin text selection highlighted, **Ctrl+C** copies it and never reaches
the agent. Without a selection, Ctrl+C retains the agent's normal interrupt/exit
behavior. A plain click or typing clears the selection. On Windows, pane copy
uses the system clipboard directly and reports success or failure; other platforms
request copying through the terminal. The conversation reader's **c** action
continues to use the terminal clipboard protocol. Paste does not clear the clipboard.

On Windows, copy a screenshot with the Snipping Tool, then press **Alt+V** in an
agent pane or the addressed composer. Rellin saves a PNG under
`~/.mrmak/attachments/YYYY-MM-DD` (or `RELLIN_HOME`, with `STATION_HOME` supported for compatibility) and inserts its quoted path
into the draft without submitting. Add your message, then press Enter. This
uses a saved-image/path-insertion flow: the native agent handles
the image; Rellin does not render an image thumbnail in its terminal composer.
Files are retained so resumed conversations can still refer to their images.

**Ctrl+V** performs the same action when the host terminal forwards that key.
Windows Terminal may intercept Ctrl+V as its own paste command, so Alt+V is the
reliable shortcut for screenshot capture. Text-only clipboard content is pasted
as text. A paste stays with its initiating seat if focus changes; closing a
composer cancels insertion into that draft. Other platforms can still paste image
file paths through the native agent; Rellin's clipboard-image capture is Windows
only in this first implementation.

Rellin also records attention state per seat: process lifecycle, activity,
completion/read versions, unread results, waiting reasons, errors, and the source
of the evidence (native events, input, screen, timer, or process). These snapshots
and their transitions are persisted together in the ledger. Native completions
are deduplicated; a quiet terminal never counts as a completed response.

Unread state carries into resumed runs. Focus changes, resizing, new prompts,
and opening the conversation reader do not mark responses read. The internal
`createAttentionTracker(...).acknowledge(seatIndex, completionVersion)` API only
acknowledges the specified version, leaving newer responses unread.

**Alt+N** focuses the next seat needing attention, in order: blocked, unverified,
provider error/nonzero exit, then unread. It opens the seat in the Console without
changing message addressing or marking anything read. **Alt+1..4** still focuses
a particular seat. In the running conversation reader (**Alt+T**), **m** activates
the displayed **read vN** action. This acknowledges through the version captured
when that snapshot loaded; answers arriving afterward stay unread. Press **r**
to load a newer snapshot. Saved-history browsing does not offer a read action.

State labels follow the [shared vocabulary](docs/attention-vocabulary.md):
`● idle`, `◐ working 1:24`, `■ blocked · approval ?scr`, `✓ done · 2 unread`,
`◌ unverified`, `▲ error · <provider code>`, `✕ exited 1 ?prc`, and `○ empty`.
Unread is completion version minus read version, including while working or
blocked. Native evidence is unmarked; screen, timer, input, and process evidence
carry `?scr`, `?tmr`, `?inp`, and `?prc`. A working timer is elapsed time, not a
heartbeat. Missing tracking never displays idle or qualifies a seat as ready.
The shelf, table, and reader use these primitives. Notifications and a structured
approval inbox remain future work.

Native completion coverage follows the existing Claude/Codex/Grok watchers;
other agents have process/input/screen tracking without inferred completions.
Native provider-error detection currently recognizes Claude's API error events.
Saved snapshots describe the last observed state; use the run's `active` field
when deciding whether its Rellin process is still running.

### Cache awareness

The fifth shelf row shows the latest reported cache usage for Claude and Codex.
Click that row or press **Alt+U** for details. Counts are tokens, not subscription
allowance or money. `cache unknown` means the native history has not supplied
usage; Codex paginated SQLite history currently has no supported usage adapter.
Unsupported providers leave the row blank. An unreported count displays `?`.

When a Claude request reports its write-tier breakdown and a request timestamp,
Rellin shows an approximate write window. Mixed tiers use the shorter window.
Reads without a known tier show observed counts/age only; they do not extend an
old countdown. `window elapsed` does not prove the provider evicted the cache.
Timing is suppressed while working, waiting, stopped, or tracking is unhealthy.
Restart, resume, handoff and source changes reset observations until new evidence
arrives. No conversation is assumed cold merely because it is new.

In **Alt+U**, **r** toggles optional cache reminders (off initially, saved across
launches); **s** snoozes the focused seat for ten minutes. Arrow keys, Page Up/Down,
or the mouse wheel scroll details. A reminder appears once near the end of an
observed write window; it never sends an agent message or changes attention.
Billing labels use allowlisted login metadata and the launch environment, without
provider requests or quota polling. Local timing estimates and currency remain
later work.

Table discussions require every participating seat to be running and ready,
with healthy native tracking and no approval menu or unfinished terminal draft.
For a fresh empty chat, send a normal message and let it finish before convening.
Coordinated messages recheck readiness before both paste and Enter. If a menu,
new input, or another state change intervenes, Rellin reports the failure; a
pasted draft may remain for you to inspect or clear. It does not send cleanup
keys into a menu. These checks also apply to addressed messages and handoff
summary delivery; direct interaction with the agent remains available.

Each table prompt is matched against its native user message after a captured
transcript boundary. Only that request's completed answer enters the table,
even if a newer unrelated answer exists. Ambiguous or interrupted requests and
watcher failures stop the discussion with a visible reason. Missing or malformed
history, unsupported formats, and stalled tracking block coordination. Partial
records are uncertain until complete. A tracking error stays latched until the
seat's watcher is replaced; use **Alt+S** to restart after resolving the cause.
Stopping a discussion does not stop work already running in its agents.

Seat labels show **BYPASS** in inverse text for automatic launch posture;
manual has no badge. The table also shows tracking health and labels read-only
as **asked, not enforced**;
convening a discussion does not restrict their tools or change launch permissions.
Provider settings can still permit actions in manual mode, and an agent can
change its mode after launch. The displayed posture is not a live permission
audit. Enforced table permissions and concurrent writers remain future work,
subject to validation through real decision trials.

For a **fresh-chat handoff**, focus a Claude or Codex seat, press **Alt+H**, then
**Enter**. Rellin asks that agent for a structured summary, waits for its native
completion, and saves the goal, state, decisions, files, open problems, and next
steps. It opens a fresh conversation in the same seat with the same project,
agent, model, effort, and permission settings, instructed to read that summary.
Alt+H opens a compact popup over the agent panes. Enter confirms and returns to
the terminal immediately; the status bar shows progress or failure, and Alt+H
reopens details/retry. This is built into Rellin; no agent skill is required.

The original conversation remains available as a separate history entry named
`<session> · <seat> before handoff`. History records link the original and the
continuation. Summaries live in `~/.mrmak/handoffs` (or `RELLIN_HOME/handoffs`, with `STATION_HOME` supported for compatibility),
outside the project by default. Other seats keep running.

Handoff requires a running seat with a known native conversation and no current
turn, approval prompt, error, or active table discussion. Codex requires the
installed CLI's `--no-daemon` support. A fresh, empty Codex chat may not yet have
a saved conversation ID: send a first message and let it finish before handoff.
Escape dismisses the popup; an already-started handoff continues. If summary generation or startup
fails, the panel shows the error and retains the original. Enter retries, reusing
a saved summary when the original conversation has not advanced. Rellin waits
up to 15 minutes for the summary and checks that the new process stays running
through startup; provider login or approval prompts may still need your input.

Codex tracking, transcript reading, handoff, and resume support both legacy JSONL
rollouts and the paginated SQLite history observed in CLI 0.166. Rellin reads
these databases without modifying them and matches the exact seat launch owner.
Paginated history does not currently supply Rellin's detailed token-usage view.

For direct launches that bypass the picker, use these commands:

```powershell
npm start -- --seats claude --name "Terrain review"
npm start -- --history
npm start -- --resume <id-prefix>
```

After `npm link`, use `rellin` instead of `npm start --`. `--resume latest`
selects the most recent run; add `--dir <folder>` to filter history or resume
selection to that working folder. `--name` on resume names the continuation.
`--help` lists the options. The startup screen also offers a **solo** preset;
table discussions still require at least two eligible seats.

Runs retain their working folder, agent roster, model, effort, permission choice,
and known native conversation IDs. Resume opens a new run linked to the previous
one, using the same native conversations. Quitting stops the agents; it does not
leave jobs running in the background. An unfinished table is not automatically
restarted. Original native CLI history must remain on disk.

Resume currently supports Claude, Codex, and Grok when their native IDs have been
captured. New Codex sessions require the installed CLI's `--no-daemon` support for
Rellin's existing ownership-based discovery. Other agents and older runs with no
saved IDs are listed as **legacy**. Missing history or an active Rellin owner
produces an error instead of silently starting a new conversation. “Saved” means
IDs were recorded; the history command does not scan every native transcript.

Use `RELLIN_HOME` (or the legacy `STATION_HOME`) to select an alternative Rellin data directory (for example,
an isolated test environment). Native agent history still uses the provider's
own directories. Recording failure behavior is documented in
[Recording health](docs/recording-health.md).
