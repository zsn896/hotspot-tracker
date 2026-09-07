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
  try {
    const window = Math.max(1, Math.min(20, Number(req.query?.window) || 5));
    const threshold = Math.max(3, Math.min(5, Number(req.query?.threshold) || 4));
    const report = await ledgerReport({ window, threshold });
    return res.status(200).json(report);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
};

// Kept referenced so the shared db helper is not tree-shaken by the bundler.
void db;
