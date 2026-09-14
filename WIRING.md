# Forward-outcome ledger setup

`api/cron.js` now contains the integration. Do not copy additional recording calls into it.

1. Apply `ledger-schema.sql` in the intended Supabase database.
2. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` and `WORKER_SECRET` on the server. Keep these values out of browser code.
3. Set `SIGNAL_LEDGER_ENABLED=true` only after the table is ready. Without this setting, the cron response reports `signalLedger.enabled: false` and makes no ledger writes.
4. The authenticated cron records eligible five-number forecasts from its live STRONG_MANUAL analysis, then resolves closed windows from stored draws. Its existing analysis limit is six active groups. Resolution also runs when there are no active targets.
5. Read `GET /api/ledger?window=5&threshold=4`. The window selects episodes recorded with that fixed horizon; it does not rescore shorter slices of longer windows. Thresholds 3–5 are recomputed from recorded best hit counts. First-success timing is available only for the stored threshold 4.

Use `Authorization: Bearer <CRON_SECRET>` for `/api/cron` and `POST /api/sync`. Direct worker calls and Group Six run modes require `x-worker-secret: <WORKER_SECRET>`; query-string secrets are rejected. Do not expose either secret to the public UI. Public sync GET remains the existing bounded refresh path.

Recording starts when enabled; historical backfilling of unrecorded predictions would invalidate forward testing. Existing malformed or inflated episodes are not silently deleted or rewritten by this change.

`sample.capped` and `sample.openCountCapped` identify ledger read limits. P-values and intervals are exploratory under an independent-episode assumption; shared targets, overlapping windows and multiple comparisons affect interpretation.

See [AUDIT.md](AUDIT.md) for the review, tests and remaining deployment limitations.

## Forward-evidence dashboard

The main page now includes an Arabic forward-evidence panel (ledger-panel.js and ledger-panel.css). It uses the fixed five-draw / four-hit definition rather than letting a viewer select the best-looking threshold. It shows resolved successes and failures, pending episodes, the chance baseline, nominal 95% interval, per-target results and the latest 50 records with timestamps. Empty, disabled, capped and unavailable states are distinct. A failed refresh removes the previous verdict rather than presenting stale evidence as current.

Before recording, the cron rechecks the official latest draw. If it differs from the draw used for analysis, the forecast is skipped; it is not retroactively recorded or reassigned to the newer draw. This depends on the freshness of the official source and is not a guarantee of subsecond timing.

The panel's enabled indicator describes configuration, not a successful-cron heartbeat. Historical pattern labels are explicitly historical; they are not validated forward win probabilities. Existing statistics may include records from earlier code versions and should not be treated as a clean, preregistered experiment. A formal model comparison still needs a frozen version, a predeclared sample size and a separate untouched evaluation period.

If the optional ledger table is missing (PGRST205 for signal_episodes), cron reports signalLedger.ready=false and requiresSetup=true while continuing normal tracking. Other ledger failures still fail the cron response. The dashboard remains unavailable until the schema is applied; no forward results are fabricated.
