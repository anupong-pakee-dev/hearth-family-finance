// Turns budget.json (Lighthouse budget format, sizes in KB) into Lighthouse CI assertions (NFR-PERF-05).
// Lighthouse 12+ removed performance budgets, so `budgetsPath` is silently ignored; asserting on the
// resource-summary and timing audits enforces the same limits. Used by lighthouserc.cjs and the local runner.
const budgets = require('../budget.json');

/** @returns {Record<string, ['error', { maxNumericValue: number }]>} */
function budgetAssertions() {
  const out = {};
  for (const b of budgets) {
    if (b.path !== '/*') throw new Error(`budget.json: only "path": "/*" is supported (got ${b.path})`);
    for (const r of b.resourceSizes ?? []) out[`resource-summary:${r.resourceType}:size`] = ['error', { maxNumericValue: r.budget * 1024 }];
    for (const r of b.resourceCounts ?? []) out[`resource-summary:${r.resourceType}:count`] = ['error', { maxNumericValue: r.budget }];
    for (const t of b.timings ?? []) out[t.metric] = ['error', { maxNumericValue: t.budget }];
  }
  return out;
}

/** Value Lighthouse CI compares for an assertion key, read from a Lighthouse result (for the local runner). */
function measured(lhr, key) {
  const m = /^resource-summary:([\w-]+):(size|count)$/.exec(key);
  if (!m) return lhr.audits[key]?.numericValue;
  const item = lhr.audits['resource-summary']?.details?.items?.find((i) => i.resourceType === m[1]);
  return item ? (m[2] === 'size' ? item.transferSize : item.requestCount) : 0;
}

module.exports = { budgetAssertions, measured };
