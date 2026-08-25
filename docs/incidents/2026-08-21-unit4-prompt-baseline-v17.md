# Unit 4 runaway comparison: unchanged prompt vs status-review update

Date: 2026-08-21

## Question

Does replacing the status-review sentence stop the `courses` prompt from remaining inside
`THINKING` and repeating dish planning until the generation cap?

## Controlled setup

- Captured production messages: `001-0004.system-message.txt` and
  `001-0004.user-message.txt` from job `87bc3d77-b34b-43c2-82db-b7e80f7b4931`.
- Model: `llama3.1:8b` on four isolated L4 devboxes.
- Exactly 20 trials per arm, seeds 4101 through 4120.
- Up to three simultaneous requests per box; concurrency changes elapsed time, not trial count.
- `temperature: 0.1`, `num_ctx: 10008`, `num_predict: 6000`.
- A runaway means the response reached the measurement cap without `--- THINKING END ---`, a
  post-THINKING table, or a terminal status marker.
- Every raw response was written immediately to its arm directory.

## The only candidate change

Baseline:

> Critically review the completed table against every Pass and Fail criterion before choosing a status.

Candidate:

> Use the chain-of-thought method and critically review the completed table against every Pass and Fail criterion before choosing a status.

No other captured system or user message text changed.

## Human-readable result

| Measure | Unchanged baseline | One-line candidate |
|---|---:|---:|
| Trials | 20 | 20 |
| Closed THINKING + table + terminal status | 19 | 19 |
| Runaways | 1 | 1 |
| Runaway rate | 5% | 5% |
| Average duration | 116.4 s | 98.2 s |
| Longest duration | 315.9 s | 280.4 s |
| Responses at least 12,000 characters | 2 | 6 |

The candidate did **not** reduce the observed runaway rate. It completed faster on average, but
produced more unusually long responses. That is not a clean improvement.

The same seeds did not fail in both arms:

- Baseline run 8, seed 4108: 315.9 s, 28,419 characters, no THINKING close/table/status.
  Candidate seed 4108 completed normally in 72.6 s.
- Candidate run 17, seed 4117: 280.4 s, 23,422 characters, no THINKING close/table/status.
  Baseline seed 4117 completed normally in 148.7 s.

## Failure attribution requested from the model

For each runaway, the model received only that arm's original prompt and this observed-failure
description: it repeatedly planned/described rows inside THINKING until the cap without closing
THINKING or producing the table. It was asked which exact prompt line told it to repeat, with any
quote required to be a verbatim substring of the original prompt.

Both final answers were:

> No explicit instruction to repeat planning or generating the table.

Earlier attribution attempts were rejected because the model quoted its own failed output as if it
were prompt text. Those invalid answers are not evidence about prompt causation.

The prompt does contain repeated per-mealtime/count requirements, but it also explicitly says that
repeating any table content is not chain-of-thought. The model did not identify an exact prompt line
that instructed repetition.

## Evidence paths

- Baseline summary: `.scratch/iter/stuck-runs/87bc3d77-courses/baseline-unit4-20/current.report.txt`
- Baseline structured results: `.scratch/iter/stuck-runs/87bc3d77-courses/baseline-unit4-20/results.json`
- Baseline runaway: `.scratch/iter/stuck-runs/87bc3d77-courses/baseline-unit4-20/run-08.raw.txt`
- Baseline attribution: `.scratch/iter/stuck-runs/87bc3d77-courses/baseline-unit4-20/run-08-attribution.txt`
- Candidate summary: `.scratch/iter/stuck-runs/87bc3d77-courses/candidate-unit4-20/current.report.txt`
- Candidate structured results: `.scratch/iter/stuck-runs/87bc3d77-courses/candidate-unit4-20/results.json`
- Candidate runaway: `.scratch/iter/stuck-runs/87bc3d77-courses/candidate-unit4-20/run-17.raw.txt`
- Candidate attribution: `.scratch/iter/stuck-runs/87bc3d77-courses/candidate-unit4-20/run-17-attribution.txt`

## Conclusion

Reject this one-line candidate as a runaway fix. In this controlled 20-vs-20 comparison, both arms
failed once, and the candidate increased the count of very long responses.
