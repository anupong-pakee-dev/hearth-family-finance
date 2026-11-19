// Signs in as the seeded demo user before Lighthouse audits authenticated pages (NFR-PERF-02).
// Credentials come from the demo seed (apps/web/scripts/seed-demo.ts) — development data only.
module.exports = async (browser, context) => {
  if (context.url.endsWith('/login')) return;
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login');
  if (!page.url().includes('/login')) { await page.close(); return; }
  await page.type('#f-email', process.env.DEMO_EMAIL || 'family@hearth.test');
  await page.type('#f-password', process.env.DEMO_PASSWORD || 'demo-hearth-family-2026');
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.close();
};
