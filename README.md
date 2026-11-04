# E1 pipeline (fixed)

Node >= 20, zero dependencies, no network or secrets.

    npm test                             # node test.js && node test-edge.js
    node pipeline.js --out output.json   # prints the result; --out also writes the file

`test.js` is the untouched visible suite; `test-edge.js` adds 16 edge-case, schema and CLI checks. `test-log.txt` is my local run.

## Choices
- **Dedup (E-P1):** keyed by `event_id`, compared as canonical JSON (keys sorted recursively; array order and value types kept). The first occurrence claims the id; an identical replay is dropped silently; a different payload is never applied and logs `conflicting_event_payload` once per conflicting arrival.
- **Validation:** missing or mistyped fields, negative amounts, bad grades or an unknown decision log `malformed_event`; an unknown `type` logs `unrecognized_event_type`. Neither enters history, since neither fits the history schema.
- **History/notes (E-P2):** accepted first occurrences in arrival order, including notes, future events and rejected corrections (9 rows here). Only `amount_inr`, `grade` and `supersedes` are ever read, so note or outcome text cannot change state.
- **Execution (E-P3):** unique executes on or before `assessment_day`, summed exactly in scaled integers.
- **Maturity/grade (E-P4):** immature iff `assessment_day < maturity_day`: grade null, reason `immature`. Otherwise the grade is the last eligible outcome or valid correction by (day, arrival). Future-day events change nothing but stay in history. Precedence: immature > unapproved > over_target > null.
- **Corrections (E-P5):** checked after the whole stream is read, so arrival order matters only on the same day. Valid = same decision, supersedes an outcome strictly earlier by (day, arrival), day <= `assessment_day`, decision mature. Anything else logs `invalid_correction_target`.
- **Entrypoint:** the starter's `file://${argv[1]}` check never matches on Windows, so `node pipeline.js` printed nothing there; it now compares real paths.

AI use: built with Claude (Anthropic); I reviewed the choices and reran the tests locally.
