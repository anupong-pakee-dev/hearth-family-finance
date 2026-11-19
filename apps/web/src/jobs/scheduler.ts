/**
 * Background jobs (§9): recurring items, DCA reminders, due-date / budget / bucket / emergency alerts,
 * daily net-worth snapshots, bucket rollover, session cleanup, hard deletion and scheduled backups.
 */
import type { Db, Q } from '../db/index.ts';
import { log } from '../log.ts';
import { config } from '../config.ts';
import { translator, type Lang } from '../i18n/index.ts';
import { sendMail } from '../services/mail.ts';
import { netWorth, emergencyStatus, currentCycle, nextDue } from '../services/summary.ts';
import { bucketMove } from '../services/finance.ts';
import { postOccurrence } from '../routes/budget.ts';
import { createBackup } from '../services/backup.ts';
import { fxProvider, refreshRates, allPairs } from '../services/fx.ts';
import { sendPush, type PushSub } from '../services/push.ts';
import { registry } from '../services/plugins.ts';
import { fieldCipher, unwrapDataKey } from '../security/keys.ts';
import { todayIso, addDays, addMonths, nextOccurrence, daysBetween, divRound, type Frequency } from '@hearth/engine';
import type { Prefs } from '../http/app.ts';
import { makeFmt } from '../views/format.ts';
import { detectSubscriptions } from '../services/subscriptions.ts';

export interface QueuedMsg { title: string; body: string; url: string }
export interface Outbox { email: QueuedMsg[]; push: QueuedMsg[]; plugins: QueuedMsg[] }
export const newOutbox = (): Outbox => ({ email: [], push: [], plugins: [] });

/**
 * Deliver a notification on the channels the user enabled (FR-NOTI-04): in-app immediately; e-mail, Web Push and
 * plugin channels are queued and sent after the transaction commits (never open a second transaction inside one).
 */
export async function dispatch(out: Outbox, q: Q, userId: string, prefs: Prefs, type: string, title: string, body: string, link: string | null, dedupe: string | null) {
  const ch = prefs.notify_prefs?.[type] ?? {};
  const inapp = ch.inapp ?? true;
  let isNew = true;
  if (dedupe) isNew = !(await q.one('select 1 from notifications where owner_id = $1 and dedupe_key = $2', [userId, dedupe]));
  if (inapp || dedupe) {
    // a row is also kept for external-only channels so the dedupe key prevents repeated sends
    await q.query(`insert into notifications(owner_id, kind, title, body, link, dedupe_key, read_at) values ($1,$2,$3,$4,$5,$6, case when $7 then null else now() end) on conflict (owner_id, dedupe_key) do nothing`, [userId, type, title, body, link, dedupe, inapp]);
  }
  if (!isNew) return;
  const msg = { title, body, url: `${config.baseUrl}${link ?? '/'}` };
  if (ch.email ?? (type === 'security')) out.email.push(msg);
  if (ch.push) out.push.push(msg);
  if (ch.plugins) out.plugins.push(msg);
}

/** Send everything queued in an outbox (after the user's transaction committed). */
export async function deliver(db: Db, userId: string, out: Outbox) {
  if (!out.email.length && !out.push.length && !out.plugins.length) return;
  const u = await db.system((s) => s.one<any>('select email, data_key_enc, data_key_version from users where id = $1', [userId]));
  if (!u) return;
  for (const m of out.email) await sendMail(u.email, m.title, `${m.body}\n\n${m.url}`);
  if (out.push.length) {
    const subs = await db.asUser(userId, (q) => q.query<PushSub>('select id, endpoint, p256dh, auth from push_subscriptions where owner_id = hearth_uid()'));
    for (const m of out.push) await sendPush(db, userId, subs, m);
  }
  if (out.plugins.length) {
    const channels = await db.asUser(userId, (q) => q.query<any>('select id, kind, config_enc from notification_channels where owner_id = hearth_uid() and enabled'));
    const c = fieldCipher(unwrapDataKey(userId, u.data_key_enc ? Buffer.from(u.data_key_enc) : null, u.data_key_version));
    for (const ch of channels) {
      const plugin = registry.channels.get(ch.kind);
      if (!plugin) continue;
      let error: string | null = null;
      try {
        const cfg = JSON.parse(c.dec(ch.config_enc) || '{}');
        for (const m of out.plugins) await plugin.send(cfg, m);
      } catch (e) { error = (e as Error).message.slice(0, 200); }
      await db.asUser(userId, (q) => q.query('update notification_channels set last_error = $2 where id = $1', [ch.id, error]));
    }
  }
}

async function perUser(db: Db, userId: string, today: string) {
  const out = newOutbox();
  await perUserTx(db, userId, today, out);
  await deliver(db, userId, out);
}

async function perUserTx(db: Db, userId: string, today: string, mails: Outbox) {
  await db.asUser(userId, async (q) => {
    const prefs = await q.one<Prefs>('select * from user_preferences where user_id = hearth_uid()');
    if (!prefs) return;
    const t = translator(prefs.locale as Lang);
    const cyc = currentCycle(prefs, today);

    // 1. recurring (FR-REC-03)
    const due = await q.query<any>(`select *, next_date::text next_date, end_date::text end_date from recurring_rules where owner_id = hearth_uid() and active and next_date <= $1`, [today]);
    for (const r of due) {
      if (r.auto_create) {
        let guard = 0;
        let rule = r;
        while (rule && rule.next_date <= today && guard++ < 31) {
          await postOccurrence(q, rule);
          rule = await q.one<any>('select *, next_date::text next_date from recurring_rules where id = $1 and active', [r.id]);
        }
      } else {
        await dispatch(mails, q, userId, prefs, 'debt_due', t('noti.recurring_pending', { name: r.name }), '', '/recurring', `rec-${r.id}-${r.next_date}`);
      }
    }

    // 2. DCA reminders (FR-INV-04)
    if (prefs.investment_enabled) {
      const dca = await q.query<any>(`select d.*, d.next_date::text next_date, a.symbol from dca_plans d join assets a on a.id = d.asset_id where d.owner_id = hearth_uid() and d.active and d.next_date <= $1`, [today]);
      for (const d of dca) {
        await q.query(`insert into investment_transactions(portfolio_id, asset_id, owner_id, household_id, type, date, amount, pending, dca_plan_id, created_by)
           select $1, $2, owner_id, household_id, 'buy', $3, $4, true, $5, owner_id from portfolios where id = $1`, [d.portfolio_id, d.asset_id, d.next_date, d.amount, d.id]);
        await dispatch(mails, q, userId, prefs, 'debt_due', t('noti.dca_due', { symbol: d.symbol }), '', `/invest/portfolios/${d.portfolio_id}`, `dca-${d.id}-${d.next_date}`);
        await q.query('update dca_plans set next_date = $2 where id = $1', [d.id, nextOccurrence(d.next_date, 'monthly' as Frequency)]);
      }
    }

    // 3. debt due / overdue (FR-FDEBT-09)
    const debts = await q.query<any>(`select d.id, d.name, d.due_day, d.owner_id, d.household_id from debts d where d.closed_at is null and not d.is_receivable and d.due_day is not null and hearth_can_write(d.owner_id, d.household_id)`);
    for (const d of debts) {
      const nd = nextDue(d.due_day, today);
      const days = daysBetween(today, nd);
      if (days >= 0 && days <= 3) {
        await dispatch(mails, q, userId, prefs, 'debt_due', t('noti.debt_due', { name: d.name, date: nd }), '', `/debts/${d.id}`, `due-${d.id}-${nd}`);
      }
      const prevDue = addMonths(nd, -1);
      if (d.owner_id === userId && prevDue < today && daysBetween(prevDue, today) <= 10) {
        const paid = await q.one('select 1 from debt_payments where debt_id = $1 and date >= $2', [d.id, addDays(prevDue, -7)]);
        if (!paid) await dispatch(mails, q, userId, prefs, 'debt_due', t('noti.debt_overdue', { name: d.name }), '', `/debts/${d.id}`, `overdue-${d.id}-${prevDue}`);
      }
    }

    // 4. budget alerts (FR-BUD-02)
    const lines = await q.query<any>(`select l.id, l.amount, l.period, c.name, coalesce((select sum(t.amount) from transaction_lines t join categories tc on tc.id = t.category_id
         where t.owner_id = hearth_uid() and t.kind = 'expense' and t.date between $2 and $3 and (tc.id = l.category_id or tc.parent_id = l.category_id)),0)::bigint spent
       from budget_lines l join categories c on c.id = l.category_id where l.owner_id = hearth_uid() and l.month = $1`, [cyc.start.slice(0, 7), cyc.start, cyc.end]);
    for (const l of lines) {
      const monthly = divRound(l.amount, l.period === 'yearly' ? 12n : l.period === 'quarterly' ? 3n : 1n);
      if (monthly <= 0n) continue;
      const pctE4 = Number((l.spent * 1_000_000n) / monthly);
      if (pctE4 >= 1_000_000) await dispatch(mails, q, userId, prefs, 'budget', t('noti.budget_over', { name: l.name }), '', '/budget', `bud100-${l.id}`);
      else if (pctE4 >= prefs.budget_warn_e4) await dispatch(mails, q, userId, prefs, 'budget', t('noti.budget_near', { name: l.name }), '', '/budget', `bud80-${l.id}`);
    }

    // 5. negative buckets (FR-BKT-09)
    if (prefs.bucket_mode !== 'off') {
      const neg = await q.query<any>(`select id, name from buckets where owner_id = hearth_uid() and not archived and balance < 0`);
      for (const b of neg) await dispatch(mails, q, userId, prefs, 'bucket_negative', t('noti.bucket_negative', { name: b.name }), '', '/buckets', `bneg-${b.id}-${today}`);

      // 8. rollover at the start of a new cycle (FR-BKT-08)
      if (today === cyc.start) {
        const rb = await q.query<any>(`select id, name, balance, rollover_policy, rollover_bucket_id from buckets where owner_id = hearth_uid() and not archived and rollover_policy <> 'carry' and balance > 0
           and not exists (select 1 from bucket_movements m where m.bucket_id = buckets.id and m.kind = 'rollover' and m.created_at::date >= $1)`, [cyc.start]);
        const savings = await q.one<any>(`select id from buckets where owner_id = hearth_uid() and not archived and type = 'savings' order by sort limit 1`);
        for (const b of rb) {
          await bucketMove(q, userId, b.id, 0n - (b.balance as bigint), 'rollover', null, 'rollover');
          const target = b.rollover_policy === 'to_bucket' ? b.rollover_bucket_id ?? savings?.id : null;
          if (target && target !== b.id) await bucketMove(q, userId, target, b.balance, 'rollover', null, b.name);
        }
      }
    }

    // 6. emergency fund below starter level (FR-NOTI-03)
    const emg = await emergencyStatus(q, 'mine', prefs);
    if (emg.essential > 0n && emg.runway < 1) await dispatch(mails, q, userId, prefs, 'emergency_low', t('noti.emergency_low'), '', '/emergency', `emg-${cyc.start}`);

    // 9. weekly (Monday) and monthly (cycle start) summary (FR-NOTI-05)
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow === 1 || today === cyc.start) {
      const kind = today === cyc.start ? 'month' : 'week';
      const from = kind === 'week' ? addDays(today, -7) : addMonths(cyc.start, -1);
      const to = addDays(today, -1);
      const sum = await q.one<any>(`select coalesce(sum(amount) filter (where kind='income'),0)::bigint inc, coalesce(sum(amount) filter (where kind='expense'),0)::bigint exp
         from transaction_lines where owner_id = hearth_uid() and date between $1 and $2`, [from, to]);
      const top = await q.one<any>(`select coalesce(p.name, c.name) name, sum(t.amount)::bigint total from transaction_lines t join categories c on c.id = t.category_id left join categories p on p.id = c.parent_id
         where t.owner_id = hearth_uid() and t.kind = 'expense' and t.date between $1 and $2 group by 1 order by 2 desc limit 1`, [from, to]);
      const f = makeFmt({ ...prefs, privacy_mode: false }, prefs.locale);
      await dispatch(mails, q, userId, prefs, 'summary', t(`noti.summary_${kind}`), t('noti.summary_body', { income: f.money(sum.inc), expense: f.money(sum.exp), top: top ? `${top.name} ${f.money(top.total)}` : '—' }), '/reports', `sum-${kind}-${today}`);
    }

    // 10. subscription price increases / undeclared subscriptions (FR-REC-06), once per cycle
    if (today === cyc.start) {
      const subs = await detectSubscriptions(q, today);
      for (const sItem of subs.filter((x) => x.increased)) {
        await dispatch(mails, q, userId, prefs, 'subscription', t('noti.sub_increase', { name: sItem.payee }), '', '/recurring', `sub-${sItem.payee}-${cyc.start}`);
      }
    }

    // 7. daily net-worth snapshot (NFR-PERF-19, DASH-13)
    const nw = await netWorth(q, 'mine', prefs);
    await q.query(`insert into net_worth_snapshots(owner_id, date, assets, liabilities, investments) values (hearth_uid(), $1, $2, $3, $4)
       on conflict (owner_id, date) do update set assets = excluded.assets, liabilities = excluded.liabilities, investments = excluded.investments`, [today, nw.assets, nw.liabilities, nw.investments]);
  });
}

/** Refresh FX rates and plugin-sourced prices (FR-TXN-11, FR-INV-11). Only runs when a plugin is enabled. */
async function refreshMarketData(db: Db, today: string) {
  // FX: accounts, assets and everyone's watch-list (services/fx.ts; no-op without an FX plugin)
  if (fxProvider()) await refreshRates(db, today, await allPairs(db));
  for (const pp of registry.prices.values()) {
    const assets = await db.system((q) => q.query<any>('select id, owner_id, symbol, currency, asset_class from assets where price_source = $1', [pp.id]));
    if (!assets.length) continue;
    try {
      const prices = await pp.fetchPrices(assets);
      for (const a of assets) {
        const price = prices.get(a.symbol.toUpperCase());
        if (price && price > 0) await db.system((q) => q.query(`insert into price_history(asset_id, owner_id, date, price_e8, source) values ($1,$2,$3,$4,$5) on conflict (asset_id, date) do update set price_e8 = excluded.price_e8, source = excluded.source`, [a.id, a.owner_id, today, BigInt(Math.round(price * 1e8)), pp.id]));
      }
    } catch (e) { log.warn('price plugin failed', { plugin: pp.id, err: (e as Error).message }); }
  }
}

let lastBackup = 0;
let lastMarketRefresh = '';

export async function runJobs(db: Db, today = todayIso()) {
  const t0 = Date.now();
  await db.system(async (q) => {
    await q.query(`delete from sessions where expires_at < now() or last_seen_at < now() - interval '1 day'`);
    await q.query(`delete from email_tokens where expires_at < now() - interval '1 day'`);
    // hard delete accounts whose deletion was requested (data key already shredded) — NFR-SEC-18
    await q.query(`delete from users where delete_requested_at is not null and delete_requested_at < now() - interval '1 hour'`);
  });
  if (lastMarketRefresh !== today) { lastMarketRefresh = today; await refreshMarketData(db, today); }
  const users = await db.system((q) => q.query<{ id: string }>('select id from users where not disabled and delete_requested_at is null'));
  let failed = 0;
  for (const u of users) {
    try { await perUser(db, u.id, today); } catch (e) { failed++; log.error('job failed for user', { err: (e as Error).message }); }
  }
  if (config.backupIntervalHours > 0 && Date.now() - lastBackup > config.backupIntervalHours * 3_600_000 && (config.backupDir || config.isProd)) {
    try { await createBackup(db, null); lastBackup = Date.now(); } catch (e) { log.error('backup failed', { err: (e as Error).message }); }
  }
  log.info('jobs done', { users: users.length, failed, ms: Date.now() - t0 });
}

export function startJobs(db: Db) {
  if (process.env.HEARTH_JOBS === 'off') return;
  const tick = () => runJobs(db).catch((e) => log.error('jobs crashed', { err: (e as Error).message }));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}
