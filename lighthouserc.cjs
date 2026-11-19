// Lighthouse CI (NFR-PERF-01..05): every category must score 100 on the mobile preset.
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'HEARTH_JOBS=off node apps/web/src/server.ts',
      startServerReadyPattern: 'Hearth listening',
      numberOfRuns: 3,
      puppeteerScript: './.lighthouse/login.cjs',
      puppeteerLaunchOptions: { args: ['--no-sandbox'] },
      settings: { preset: undefined, formFactor: 'mobile', throttlingMethod: 'simulate', budgetsPath: './budget.json' },
      url: [
        'http://localhost:3000/login',
        'http://localhost:3000/onboarding',
        'http://localhost:3000/',
        'http://localhost:3000/transactions',
        'http://localhost:3000/debts',
        'http://localhost:3000/debts/plan',
        'http://localhost:3000/goals',
        'http://localhost:3000/invest',
        'http://localhost:3000/settings',
      ],
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
        'categories:seo': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
        'first-contentful-paint': ['error', { maxNumericValue: 1000 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 1500 }],
        'total-blocking-time': ['error', { maxNumericValue: 50 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.01 }],
        'speed-index': ['error', { maxNumericValue: 1500 }],
      },
    },
    upload: { target: 'temporary-public-storage' },
  },
};
