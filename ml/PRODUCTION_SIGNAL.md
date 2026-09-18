# Production signal gate

`lib/production-signal.js` is the production gate used by the Group Five
selector. It does not claim that a random draw is predictable. Its job is to
stop a short-lived frequency spike from being labelled as a strong signal.

For each five-number candidate it:

1. rejects malformed or non-contiguous draw archives;
2. measures 3+ and 4+ hits in complete 20, 40 and 80-draw windows;
3. computes a one-sided Wilson lower bound and compares it with the exact
   hypergeometric 4+ baseline for a fixed set of five numbers;
4. requires the evidence to repeat in at least two complete windows before it
   can become `MEDIUM`, and in all three windows before it can become `STRONG`.

The existing persistent-core score remains part of ranking. The production
evidence adds a small bounded tie-break weight and is returned as
`analysis.productionSignal`, so the UI and API can explain why a candidate was
selected. If no candidate clears the gate, the selector still returns the
best-ranked group for compatibility, but its signal status remains `ABSTAIN`.
