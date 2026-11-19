// Load test (NFR-PERF-15/20): 1,000 concurrent users on 2 vCPU / 4 GB; API p95 < 200 ms, p99 < 500 ms.
//   k6 run -e BASE=https://staging.example.com -e USERS=1000 deploy/k6/load.js
// Users are created on the fly (open registration must be enabled on the staging instance).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:3000';
const USERS = Number(__ENV.USERS || 1000);

export const options = {
  scenarios: {
    steady: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '2m', target: USERS }, { duration: '5m', target: USERS }, { duration: '1m', target: 0 }] },
  },
  thresholds: {
    'http_req_duration{kind:api}': ['p(95)<200', 'p(99)<500'],
    'http_req_duration{kind:page}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

const csrfOf = (body) => (/name="_csrf" value="([^"]+)"/.exec(body) || [])[1];

export function setup() { return { started: Date.now() }; }

export default function () {
  const jar = http.cookieJar();
  if (!jar.cookiesForURL(BASE).hearth) {
    const email = `k6-${__VU}-${Date.now()}@load.test`;
    const reg = http.get(`${BASE}/register`);
    http.post(`${BASE}/register`, { _csrf: csrfOf(reg.body), email, password: `load-test-password-${__VU}`, name: `VU ${__VU}` }, { redirects: 0 });
    const onb = http.get(`${BASE}/onboarding`);
    const t = csrfOf(onb.body);
    http.post(`${BASE}/onboarding/accounts`, { _csrf: t, name: 'Bank', type: 'savings', opening: '100000' }, { redirects: 0 });
    http.post(`${BASE}/onboarding/invest`, { _csrf: t, invest: 'no' }, { redirects: 0 });
  }
  const dash = http.get(`${BASE}/`, { tags: { kind: 'page' } });
  check(dash, { 'dashboard 200': (r) => r.status === 200 });
  const form = http.get(`${BASE}/transactions/new`, { tags: { kind: 'page' } });
  const acc = (/name="account_id"[^>]*>\s*<option value="([^"]+)"/.exec(form.body) || [])[1];
  const res = http.post(`${BASE}/api/v1/transactions`, JSON.stringify({ kind: 'expense', amount: String(50 + Math.floor(Math.random() * 500)), account_id: acc, payee: 'k6' }), {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfOf(form.body) }, tags: { kind: 'api' },
  });
  check(res, { 'create 201': (r) => r.status === 201 });
  check(http.get(`${BASE}/api/v1/summary`, { tags: { kind: 'api' } }), { 'summary 200': (r) => r.status === 200 });
  check(http.get(`${BASE}/transactions`, { tags: { kind: 'page' } }), { 'list 200': (r) => r.status === 200 });
  sleep(1 + Math.random() * 2);
}
