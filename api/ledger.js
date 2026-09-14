'use strict';

// Place at api/ledger.js
//
// GET /api/ledger              -> the forward-outcome report
// GET /api/ledger?window=5     -> override the scoring window
//
// Read-only. Recording happens in the cron tick (see WIRING.md).

const { db } = require('./lib');
const { ledgerReport } = require('../lib/signal-ledger');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const window = Number(req.query?.window ?? 5);
    const threshold = Number(req.query?.threshold ?? 4);
    if (!Number.isInteger(window) || window < 1 || window > 20 || !Number.isInteger(threshold) || threshold < 3 || threshold > 5) {
      return res.status(400).json({ ok: false, error: 'window must be 1–20 and threshold must be 3–5 (integers)' });
    }
    const report = await ledgerReport({ window, threshold });
    return res.status(200).json(report);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
};

// Kept referenced so the shared db helper is not tree-shaken by the bundler.
void db;
