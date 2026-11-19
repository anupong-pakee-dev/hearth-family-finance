# Requirements status (v0.2.0 vs requirements v0.4)

Legend: ✅ done (tested where testable) · ⚙️ implemented as configuration/workflow, runs in CI or on infrastructure · ❌ not done

Every functional requirement (§4) is implemented. The items that remain are activities that need people or
infrastructure outside this repository, listed at the bottom.

## 4.1 Accounts & households
| ID | Status | Notes |
|---|---|---|
| FR-AUTH-01/02/03/06/07 | ✅ | Email + password, verification, reset, TOTP + recovery codes, sessions, open/invite-only registration |
| FR-AUTH-04 OIDC | ✅ | Admin-configured providers (Google, GitHub via OIDC bridge, Keycloak…): code flow + PKCE, state, nonce, JWKS-verified id_token; sign-up only if allowed and e-mail verified; never auto-links by e-mail (takeover protection); linking/unlinking from Security. Tested with a mock IdP |
| FR-AUTH-05 Passkey | ✅ | WebAuthn registration (step-up required) and passwordless sign-in with discoverable credentials, ES256/RS256, UV required, counter check. Tested with a simulated authenticator |
| FR-HH-01…07 | ✅ | |

## 4.2 Buckets
| ID | Status | Notes |
|---|---|---|
| FR-BKT-00…12 | ✅ | incl. 00c: each member opts in/out of shared household buckets |

## 4.3 Transactions
| ID | Status | Notes |
|---|---|---|
| FR-TXN-01…03, 07…10, 12 | ✅ | incl. "recorded by" filter |
| FR-TXN-04 split | ✅ | Up to 4 parts per transaction (categories and/or buckets); reports read the `transaction_lines` view |
| FR-TXN-05 receipts | ✅ | JPEG/PNG/WebP/PDF ≤ 5 MB, type sniffed from content, EXIF/XMP/text chunks stripped, encrypted, served as `attachment` with a sandbox CSP |
| FR-TXN-06 slip QR / OCR | ✅ | "Read a slip": Thai/English OCR (tesseract.js in a Web Worker) reads a transfer-slip photo **on the device** and pre-fills amount, date, payee and reference — the image is never uploaded or stored; PromptPay (EMVCo) / slip QR via BarcodeDetector as before |
| FR-TXN-11 multi-currency | ✅ | Per-account currency, per-transaction FX rate (manual or latest), reports converted to the main currency; rates entered by admins or fetched by an FX plugin |

## 4.4 Debts / 4.8 Family debts
| ID | Status | Notes |
|---|---|---|
| FR-DEBT-01…17 | ✅ | incl. 17: on payoff, the debt bucket's automatic allocation and leftover money roll into the next debt in plan order |
| FR-FDEBT-01…10 | ✅ | incl. 05 debt-free date per person + whole household, 08 net amounts members owe each other (lender member) |

## 4.5 Savings · 4.6 Emergency
| ID | Status | Notes |
|---|---|---|
| FR-SAVE-01…10 | ✅ | incl. 09: 52-week and daily-increment challenges with today's amount, due-so-far and one-tap deposit |
| FR-EMG-01…08 | ✅ | 07: the household view aggregates shared spending and shared emergency buckets |

## 4.7 Investments
| ID | Status | Notes |
|---|---|---|
| FR-INV-01…26 | ✅ | incl. 04 DCA creates pending buys to confirm with real units; 11 price-feed plugins (CoinGecko example) with per-asset source; 18 value by currency + FX effect; 22 configurable SSF/RMF/ThaiESG caps; 24 portfolios for (dependent) members |

## 4.9 Dashboard & charts
| ID | Status | Notes |
|---|---|---|
| DASH-01…21 | ✅ | New Analytics page: DASH-03 Sankey, 04 category trends, 13 net worth over time (snapshots or reconstructed history), 15 calendar heatmap |
| Shared rules | ✅ | Range picker (this period / 3 / 6 / 12 months / YTD / custom), mine/household/all, drill-down (bars, Sankey nodes, heatmap days and category rows link to filtered transactions), dark mode, non-colour cues, hideable cards, hidden modules |

## 4.10–4.15
| ID | Status | Notes |
|---|---|---|
| FR-BUD-01…04, FR-REC-01…05 | ✅ | |
| FR-REC-06 | ✅ | Repeating payees detected; price increases flagged on the Recurring page and notified once per cycle |
| FR-NOTI-01 | ✅ | In-app, e-mail, **Web Push** (RFC 8291/8292 on node:crypto) |
| FR-NOTI-02 | ✅ | Plugins: LINE Messaging API, Telegram, Discord, generic HTTPS webhook (HMAC-signed); per-user, encrypted config, SSRF-guarded |
| FR-NOTI-03/04/05 | ✅ | Per type × channel (in-app/email/push/plugins); weekly (Monday) and monthly summaries |
| FR-IO-01…06 | ✅ | 02/06: presets for Thai banks (generic, KBank, SCB, KTB, BBL) and Money Lover, YNAB, Firefly III with auto-detection |
| FR-RPT-01…05 | ✅ | 05: print stylesheet → "Save as PDF" from the browser (keeps Thai fonts without embedding font files) |
| FR-SET-01…06 | ✅ | |

## 5. Non-functional
| Area | Status | Notes |
|---|---|---|
| NFR-SEC-01…12, 14, 16–22, 24, 25, 32–35, 37, 38 | ✅ | NFR-SEC-12: users grant time-limited, audited, read-only support access to a chosen admin |
| NFR-SEC-15 | ✅ | Env / secret file / **HashiCorp Vault KV** / **AWS Secrets Manager** (SigV4) adapters, rotation script |
| NFR-SEC-13, 23 | ⚙️ | HSTS sent by the app; TLS at the reverse proxy; verify A+ on the deployed domain |
| NFR-SEC-26…31 | ⚙️ | CodeQL, Semgrep, OSV, gitleaks, Trivy, SBOM, cosign, SLSA provenance, ZAP, Scorecard workflows |
| NFR-PERF-01…14 | ✅ | **Lighthouse 100/100/100/100 on all 18 key pages**, mobile preset, cold cache (`npm run lighthouse:local`); ≈ 17–23 KB per page, TBT 0–11 ms, CLS ≤ 0.009 |
| NFR-PERF-15…21 | ✅ / ⚙️ | Plan maths and N+1 guards tested; k6 load test in `deploy/k6/load.js` must run against staging |
| NFR-ACC-01…04 | ✅ | |
| NFR-UX-01…05 | ✅ | 02: the add-transaction form works offline; submissions are queued in IndexedDB and replayed (Background Sync or next visit); 03: every form control is labelled (regression-tested) |
| NFR-OPS-01…04 | ✅ | |

## Needs people or infrastructure (cannot be completed inside the repository)
| Item | Why |
|---|---|
| NFR-SEC-36 external penetration test | Must be done by an independent third party before v1.0 |
| NFR-SEC-23 / Observatory A+ | Needs the public HTTPS domain |
| NFR-PERF-20 load test numbers | Run `k6 run deploy/k6/load.js` on 2 vCPU / 4 GB staging |
| NFR-SEC-31 Scorecard ≥ 8, Best Practices badge | Needs the public GitHub repository and branch protection |
| §11 decisions #2, #6a | Hosting model and trademark/domain check are business decisions |
