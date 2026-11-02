# Recording health

Rellin's live agent state and its ability to save the session record are
separate facts. A failed ledger event write leaves agents running and displays
a persistent **Record incomplete** warning in the Console and table status bar.
The warning includes the failed event type and storage error. It takes priority
over transient clipboard notices. Agent attention and unread versions are not
changed merely because recording failed.

`record(event)` returns whether SQLite saved the event. Sequence numbers advance
only after successful inserts. Failed events are not retried, and no prompts are
resent. When another event is recorded, or on clean shutdown, Rellin attempts to
append a `recording-gap` event containing the failure count, first/last failure
times, and last event type/error. A later successful write changes the live
warning to **writes recovered**, but the record remains incomplete.

History readers receive `recordingIssues`; the session picker and `--history`
label affected runs. Consumers must inspect `recording-gap` events alongside
the discussion: `table-ended: completed` describes discussion progress, not a
guarantee that every event was saved. Gap markers summarize detected failures;
they are not reconstructed missing events or a proof of overall completeness.

The optional `--ledger` JSONL mirror has independent health. Its failures show
**JSONL mirror incomplete**, without claiming that successful SQLite writes
failed. Mirror failures also produce gap metadata in SQLite when available.

On exit, Rellin prints the recording warning and database path after restoring
the terminal. Failure to finish saving exits with an error status. If storage
never becomes writable, Rellin cannot persist the gap marker; the live/exit
warning remains the available evidence. Abrupt process termination before the
marker can be written has the same limitation. Native provider history should
be checked before relying on an affected run for a durable decision.

Validation uses actual SQLite rejection triggers and writer locks, an unwritable
mirror, history reopening, and a real PTY with a fake agent. The PTY test checks
both table and Console warnings, recovery without clearing the warning, clean
exit reporting, and saved history metadata. No provider calls are needed.
