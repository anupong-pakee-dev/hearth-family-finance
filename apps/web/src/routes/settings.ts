/**
 * Settings (§4.15), security (2FA, sessions, security log), notifications prefs, export (FR-IO-04), delete account.
 */
import { get, post, htmlRes, redirect, withFlash, download, safeNext, HttpError, type Ctx } from '../http/app.ts';
import { html, raw } from '../views/html.ts';
import { qrSvg } from '../views/qrcode.ts';
import { page, icon, csrfField } from '../views/layout.ts';
import { field, input, select, form, postButton, card, checkbox, rateInput, meter } from '../views/ui.ts';
import { donut } from '../views/charts.ts';
import { PRESETS, sanitize, normalize } from '../../public/theme-colors.js';
import { makeFmt, inputRate, inputMoney, maskIp } from '../views/format.ts';
import { text, oneOf, intIn, rate, cipher, money } from '../services/common.ts';

/** Recovery codes are rendered once in the POST response — never placed in a URL. */
function showCodes(ctx: Ctx, codes: string[]) {
  return htmlRes(page(ctx, {
    title: ctx.t('mfa.codes_title'),
    body: card(null, html`<p>${ctx.t('mfa.codes_hint')}</p><pre class="codes">${codes.join('\n')}</pre><p><a class="btn primary" href="/settings/security">${ctx.t('common.done')}</a></p>`),
  }));
}
import { setBucketMode, ASSET_CLASSES } from '../services/finance.ts';
import { requestDeletion, securityAlert } from '../services/users.ts';
import { exportUserData, toCsv } from '../services/export.ts';
import { newTotpSecret, verifyTotp, otpauthUrl, newRecoveryCodes, hashRecoveryCode } from '../security/totp.ts';
import { verifyPassword, hashPassword, checkPassword } from '../security/password.ts';
import { audit } from '../security/audit.ts';
import { createSession, destroySession, cookie, SESSION_COOKIE } from '../security/session.ts';
import { DASH_CARDS } from './dashboard.ts';
import { registry } from '../services/plugins.ts';
import { vapid } from '../services/push.ts';
import { jsonRes } from '../http/app.ts';
import { mailEnabled } from '../services/mail.ts';

export const NOTI_TYPES = ['debt_due', 'budget', 'bucket_negative', 'goal_reached', 'emergency_low', 'household_txn', 'subscription', 'security', 'summary'] as const;
export const NOTI_CHANNELS = ['inapp', 'email', 'push', 'plugins'] as const;

get('/settings', { access: 'auth' }, async (ctx) => {
  const p = ctx.prefs!;
  const channels = await ctx.as((q) => q.query<any>('select id, kind, label, last_error from notification_channels where owner_id = hearth_uid() order by created_at'));
  const t = ctx.t;
  const yes = (v: boolean) => raw(v ? 'checked' : '');
  return htmlRes(page(ctx, {
    title: t('nav.settings'),
    scripts: ['push.js'],
    actions: html`<a class="btn" href="/settings/security">${icon('lock')} ${t('settings.security')}</a>`,
    body: html`
      ${!ctx.user!.email_verified_at ? html`<div class="flash warn">${t('auth.verify_pending')} ${mailEnabled() ? postButton(ctx, '/verify/resend', t('auth.resend'), { cls: 'sm' }) : html`<button class="btn sm" type="button" disabled aria-disabled="true" title="${t('mail.disabled_hint')}">${t('auth.resend')}</button> <span class="mail-off">${t('mail.disabled_hint')}</span>`}</div>` : ''}
      ${card(t('settings.profile'), form(ctx, '/settings/profile', html`<div class="grid2">
        ${field(t('auth.name'), input({ name: 'display_name', value: ctx.user!.display_name, required: true, maxlength: 80 }), { id: 'f-dn' })}
        ${field(t('auth.email'), input({ name: 'email_ro', value: ctx.user!.email, readonly: true }), { id: 'f-email_ro', hint: t('settings.email_change_hint') })}</div>`, { submit: t('common.save') }))}
      ${card(t('settings.display'), form(ctx, '/settings/preferences', html`<div class="grid3">
        ${field(t('settings.language'), select('locale', [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }], p.locale))}
        ${field(t('settings.currency'), input({ name: 'currency', value: p.currency, maxlength: 3, pattern: '[A-Za-z]{3}' }), { id: 'f-currency' })}
        ${field(t('settings.era'), select('date_era', [{ value: 'be', label: t('settings.era_be') }, { value: 'ce', label: t('settings.era_ce') }], p.date_era))}
        ${field(t('settings.month_start'), input({ name: 'month_start_day', type: 'number', min: 1, max: 28, value: p.month_start_day }), { id: 'f-msd', hint: t('settings.month_start_hint') })}
        ${field(t('settings.theme'), select('theme', ['system', 'light', 'dark'].map((v) => ({ value: v, label: t(`settings.theme_${v}`) })), p.theme))}
        ${field(t('settings.income'), input({ name: 'monthly_income', value: inputMoney(p.monthly_income), inputmode: 'decimal' }), { id: 'f-income', hint: t('settings.income_hint') })}
        ${field(t('settings.dsr_threshold'), rateInput('dsr', inputRate(p.dsr_threshold_e4)), { hint: '%' })}
        ${field(t('settings.budget_warn'), rateInput('budget_warn', inputRate(p.budget_warn_e4)), { hint: '%' })}
      </div>`, { submit: t('common.save') }))}
      ${card(t('colors.title'), html`<p class="note">${t('colors.intro')}</p>
        <p class="row-actions"><a class="btn" href="/settings/colors">${t('colors.open')}</a> <span class="note">${t(`colors.preset.${p.colors?.preset ?? 'sage'}`)}${p.colors?.preset ? '' : ` · ${t('colors.default')}`}</span></p>`, { id: 'colors' })}
      ${card(t('settings.modules'), form(ctx, '/settings/modules', html`
        <fieldset class="choices" id="buckets"><legend>${t('settings.bucket_mode')}</legend>
          ${(['off', 'partial', 'full'] as const).map((m) => html`<label class="choice"><input type="radio" name="bucket_mode" value="${m}" ${yes(p.bucket_mode === m)}><span><strong>${t(`bucket.mode.${m}`)}</strong><small>${t(`bucket.mode.${m}_desc`)}</small></span></label>`)}
        </fieldset>
        <p class="note">${t('settings.bucket_mode_note')}</p>
        <fieldset class="choices"><legend>${t('settings.investment')}</legend>
          <label class="choice"><input type="radio" name="investment" value="on" ${yes(!!p.investment_enabled)}><span><strong>${t('common.on')}</strong><small>${t('settings.investment_on')}</small></span></label>
          <label class="choice"><input type="radio" name="investment" value="off" ${yes(!p.investment_enabled)}><span><strong>${t('common.off')}</strong><small>${t('settings.investment_off')}</small></span></label>
        </fieldset>
        ${p.investment_enabled ? html`<div class="grid3">
          ${field(t('settings.cost_method'), select('cost_method', [{ value: 'average', label: t('settings.cost_average') }, { value: 'fifo', label: 'FIFO' }], p.cost_method))}
          ${field(t('settings.invest_warn_rate'), rateInput('invest_warn_rate', inputRate(p.invest_warn_rate_e4)), { hint: t('settings.invest_warn_rate_hint') })}
          ${field(t('settings.scenarios'), input({ name: 'scenarios', value: p.scenario_rates.join(', '), maxlength: 30 }), { id: 'f-sc', hint: t('settings.scenarios_hint') })}
        </div>
        <fieldset><legend>${t('settings.networth_exclude')}</legend><div class="checks">${ASSET_CLASSES.map((c) => checkbox('nw_exclude', t(`invest.class.${c}`), p.networth_exclude.includes(c), c))}</div></fieldset>` : ''}`, { submit: t('common.save') }))}
      ${card(t('settings.dashboard_cards'), html`<form method="post" action="/settings/dashboard" class="stack">${csrfField(ctx)}<div class="checks">
        ${DASH_CARDS.map((c) => checkbox('show', t(`settings.card.${c}`), !p.dashboard_hidden.includes(c), c))}</div><div class="actions"><button class="btn primary">${t('common.save')}</button></div></form>`)}
      ${card(t('settings.notifications'), html`<form method="post" action="/settings/notifications" class="stack">${csrfField(ctx)}
        <div class="table-wrap"><table class="tbl"><thead><tr><th>${t('settings.noti_type')}</th>${NOTI_CHANNELS.map((c) => html`<th${c === 'email' && !mailEnabled() ? raw(` title="${t('mail.disabled_hint')}"`) : ''}>${t(`settings.channel.${c}`)}</th>`)}</tr></thead>
        <tbody>${NOTI_TYPES.map((ty) => html`<tr><td>${t(`settings.noti.${ty}`)}</td>${NOTI_CHANNELS.map((c) => html`<td><input type="checkbox" name="n_${ty}_${c}" value="1" aria-label="${t(`settings.noti.${ty}`)} · ${t(`settings.channel.${c}`)}" ${yes(p.notify_prefs?.[ty]?.[c] ?? (c === 'inapp' || (c === 'email' && ty === 'security')))} ${c === 'email' && !mailEnabled() ? raw(`disabled title="${t('mail.disabled_hint')}"`) : ''}></td>`)}</tr>`)}</tbody></table></div>
        ${!mailEnabled() ? html`<p class="mail-off">${t('mail.disabled_hint')}</p>` : ''}
        <div class="actions"><button class="btn primary">${t('common.save')}</button></div></form>
        <h3>${t('settings.push_device')}</h3>
        <p class="note">${t('settings.push_intro')}</p>
        <p class="row-actions" data-push-ui hidden><button class="btn" type="button" data-push="on">${t('settings.push_enable')}</button> <button class="btn link" type="button" data-push="off">${t('settings.push_disable')}</button> <span data-push-status role="status"></span></p>
        <h3>${t('settings.channels')}</h3>
        ${channels.length ? html`<ul class="rows">${channels.map((c: any) => html`<li><span><strong>${registry.channels.get(c.kind)?.name ?? c.kind}</strong> ${c.label}${c.last_error ? html`<small class="neg">${c.last_error}</small>` : ''}</span>
          ${postButton(ctx, `/settings/channels/${c.id}/test`, t('settings.channel_test'), { cls: 'sm' })} ${postButton(ctx, `/settings/channels/${c.id}/delete`, t('common.remove'), { cls: 'sm link' })}</li>`)}</ul>` : ''}
        ${registry.channels.size ? form(ctx, '/settings/channels', html`<div class="grid3">
          ${field(t('settings.channel_kind'), select('kind', [...registry.channels.values()].map((c) => ({ value: c.kind, label: c.name })), [...registry.channels.keys()][0]))}
          ${field(t('settings.channel_label'), input({ name: 'label', maxlength: 60 }))}
          ${field(t('settings.channel_config'), input({ name: 'f1', maxlength: 500 }), { hint: [...registry.channels.values()].map((c) => `${c.name}: ${c.fields.map((f) => f.label).join(' | ')}`).join(' · ') })}
          ${field(t('settings.channel_config2'), input({ name: 'f2', maxlength: 500 }))}
        </div><p class="note">${t('settings.channels_privacy')}</p>`, { submit: t('common.add') }) : html`<p class="note">${t('settings.push_note')}</p>`}`)}
      ${card(t('settings.data'), html`<p>${t('settings.data_intro')}</p>
        <p class="row-actions"><a class="btn" href="/settings/export">${icon('download')} ${t('settings.export')}</a> <a class="btn" href="/transactions/import">${icon('upload')} ${t('io.import')}</a></p>`)}
      ${card(t('settings.danger'), html`<p>${t('settings.delete_intro')}</p>${form(ctx, '/settings/delete', html`${field(t('settings.delete_confirm_label'), input({ name: 'confirm', required: true, placeholder: 'DELETE', autocomplete: 'off' }), { id: 'f-del' })}`, { submit: t('settings.delete_account'), danger: true })}`, { cls: 'danger-zone' })}
      <p class="note">Hearth Family Finance 0.2.0 · MIT · ${t('settings.no_telemetry')}</p>`,
  }));
});

post('/settings/profile', { access: 'auth' }, async (ctx) => {
  await ctx.db.system((q) => q.query('update users set display_name = $1 where id = $2', [text(ctx.body.display_name, 80, true), ctx.user!.id]));
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

post('/settings/preferences', { access: 'auth' }, async (ctx) => {
  const income = money(ctx.body.monthly_income, { allowZero: true }) ?? ctx.prefs!.monthly_income;
  await ctx.as((q) => q.query(`update user_preferences set locale=$1, currency=$2, date_era=$3, month_start_day=$4, theme=$5, monthly_income=$6, dsr_threshold_e4=$7, budget_warn_e4=$8, updated_at=now() where user_id = hearth_uid()`, [
    oneOf(ctx.body.locale, ['th', 'en'] as const, 'th'), /^[A-Za-z]{3}$/.test(ctx.body.currency ?? '') ? ctx.body.currency.toUpperCase() : 'THB',
    oneOf(ctx.body.date_era, ['be', 'ce'] as const, 'be'), intIn(ctx.body.month_start_day, 1, 28, 1), oneOf(ctx.body.theme, ['system', 'light', 'dark'] as const, 'system'),
    income, ctx.body.dsr ? rate(ctx.body.dsr) : 400_000, ctx.body.budget_warn ? rate(ctx.body.budget_warn) : 800_000]));
  ctx.setCookies.push(cookie('lang', ctx.body.locale === 'en' ? 'en' : 'th', { maxAge: 31_536_000 }));
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

post('/settings/modules', { access: 'auth' }, async (ctx) => {
  const mode = oneOf(ctx.body.bucket_mode, ['off', 'partial', 'full'] as const, ctx.prefs!.bucket_mode);
  const inv = ctx.body.investment === 'on';
  const scen = (ctx.body.scenarios ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > -50 && n < 50).slice(0, 3);
  const exclude = (ctx.bodyAll.nw_exclude ?? []).filter((c) => (ASSET_CLASSES as readonly string[]).includes(c));
  const prev = await ctx.as(async (q) => {
    const prev = await setBucketMode(q, mode);
    await q.query(`update user_preferences set investment_enabled = $1, cost_method = coalesce($2, cost_method), invest_warn_rate_e4 = coalesce($3, invest_warn_rate_e4),
       scenario_rates = case when cardinality($4::numeric[]) = 3 then $4::numeric[] else scenario_rates end, networth_exclude = case when $5 then $6::text[] else networth_exclude end where user_id = hearth_uid()`,
    [inv, ctx.body.cost_method ? oneOf(ctx.body.cost_method, ['average', 'fifo'] as const) : null, ctx.body.invest_warn_rate ? rate(ctx.body.invest_warn_rate) : null, scen, !!ctx.prefs!.investment_enabled, exclude]);
    return prev;
  });
  if (prev === 'off' && mode !== 'off') return redirect('/buckets/wizard');
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

// ───────────── Colours & theme: presets + per-colour overrides, stored per user ─────────────
get('/settings/colors', { access: 'auth' }, async (ctx) => {
  const t = ctx.t;
  const saved = sanitize(ctx.prefs!.colors ?? {});
  const presetId = saved.preset ?? PRESETS[0].id;
  const cur: Record<string, string> = { ...PRESETS[0], ...PRESETS.find((x) => x.id === presetId), ...saved };
  // swatch strips for the preset cards — constant values, so a nonce'd <style> instead of inline styles (CSP)
  const strips = PRESETS.map((pr) => (['primary', 'inc', 'exp', 'heat', 'c2'] as const).map((k, i) => `.pz-${pr.id} i:nth-child(${i + 1}){background:${pr[k]}}`).join('')).join('');
  const colorField = (k: string, label: string, hint?: string) => html`<div class="color-field"><input type="color" id="f-col-${k}" name="${k}" value="${cur[k]}"${hint ? raw(` aria-describedby="f-col-${k}-hint"`) : ''}><label for="f-col-${k}">${label}</label>${hint ? html`<small id="f-col-${k}-hint">${hint}</small>` : ''}</div>`;
  const bars = [[80, 62], [80, 70], [86, 55], [80, 74], [80, 50]];
  const miniBars = bars.map(([a, b], i) => `<rect x="${8 + i * 60}" y="${100 - a}" width="20" height="${a}" rx="4" class="c-inc fill"/><rect x="${32 + i * 60}" y="${100 - b}" width="20" height="${b}" rx="4" class="c-exp fill"/>`).join('');
  const heatCells = [1, 2, 0, 3, 1, 2, 4, 0, 1, 3, 2, 4, 2, 1].map((l, i) => `<rect x="${(i % 7) * 44}" y="${Math.floor(i / 7) * 44}" width="38" height="38" rx="7" class="heat l${l}"/>`).join('');
  return htmlRes(page(ctx, {
    title: t('colors.title'),
    scripts: ['theme-colors.js'],
    actions: html`<a class="btn" href="/settings#colors">← ${t('nav.settings')}</a>`,
    body: html`<style nonce="${ctx.nonce}">${raw(strips)}</style>
      <p class="note">${t('colors.intro')}</p>
      <form method="post" action="/settings/colors" class="stack" data-colors>${csrfField(ctx)}
        ${card(t('colors.presets'), html`<fieldset class="choices preset-grid"><legend class="sr-only">${t('colors.presets')}</legend>
          ${PRESETS.map((pr) => html`<label class="choice preset"><input type="radio" name="preset" value="${pr.id}" ${raw(pr.id === presetId ? 'checked' : '')}><span><span class="strip pz-${pr.id}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>${t(`colors.preset.${pr.id}`)}</strong><small>${t(`colors.preset.${pr.id}_desc`)}</small></span></label>`)}
          </fieldset><div class="actions"><button class="btn" name="action" value="preset">${t('colors.apply_preset')}</button></div>`)}
        <div class="grid2">
          ${card(t('colors.custom'), html`<div class="color-grid">
              ${colorField('primary', t('colors.slot.primary'), t('colors.slot.primary_hint'))}
              ${colorField('inc', t('colors.slot.inc'), t('colors.slot.inc_hint'))}
              ${colorField('exp', t('colors.slot.exp'), t('colors.slot.exp_hint'))}
              ${colorField('heat', t('colors.slot.heat'), t('colors.slot.heat_hint'))}
            </div>
            <h3>${t('colors.cats')}</h3><p class="note">${t('colors.cats_hint')}</p>
            <div class="color-grid">${(['c1', 'c2', 'c3', 'c4', 'c5'] as const).map((k, i) => colorField(k, t('colors.cat_n', { n: i + 1 })))}</div>`)}
          ${card(t('colors.preview'), html`<div class="preview">
              <p class="note">${t('colors.preview_hint')}</p>
              <div class="preview-row"><span class="btn primary">${icon('plus')} ${t('txn.add')}</span><span class="chip-nav">${icon('home')} ${t('nav.dashboard')}</span></div>
              <ul class="rows"><li><span>${t('colors.sample_income')}</span><span class="amt pos">+฿52,000</span></li><li><span>${t('colors.sample_expense')}</span><span class="amt neg">−฿2,340</span></li></ul>
              ${meter(65, 100, t('dash.spent_pct', { pct: '65%' }))}
              <svg class="mini chart" viewBox="0 0 300 104" role="img" aria-label="${t('dash.chart.income_expense')}">${raw(miniBars)}</svg>
              ${donut({ title: t('dash.chart.by_category'), summary: t('dash.chart.by_category_sum'), items: [11_200, 9_500, 5_850, 4_200, 2_800].map((v, i) => ({ label: t('colors.cat_n', { n: i + 1 }), value: v, display: `฿${v.toLocaleString('en-US')}` })) })}
              <svg class="mini chart" viewBox="0 0 302 82" role="img" aria-label="${t('colors.slot.heat')}">${raw(heatCells)}</svg>
            </div>`)}
        </div>
        <div class="actions"><button class="btn primary" name="action" value="custom">${t('colors.save')}</button></div>
      </form>
      <div class="row-actions">${postButton(ctx, '/settings/colors/reset', t('colors.reset'), { cls: '' })}<span class="note">${t('colors.default_note')}</span></div>`,
  }));
});

post('/settings/colors', { access: 'auth' }, async (ctx) => {
  const preset = PRESETS.find((x) => x.id === ctx.body.preset) ?? PRESETS[0];
  // "Use this palette" takes the preset as-is; "Save" keeps the person's own picks on top of it
  const colors = ctx.body.action === 'preset' ? normalize({ preset: preset.id }) : normalize({ ...ctx.body, preset: preset.id });
  await ctx.as((q) => q.query('update user_preferences set colors = $1, updated_at = now() where user_id = hearth_uid()', [JSON.stringify(colors)]));
  return redirect(withFlash('/settings/colors', 'ok', 'saved'));
});

post('/settings/colors/reset', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query(`update user_preferences set colors = '{}', updated_at = now() where user_id = hearth_uid()`));
  return redirect(withFlash('/settings/colors', 'ok', 'saved'));
});

post('/settings/dashboard', { access: 'auth' }, async (ctx) => {
  const shown = new Set(ctx.bodyAll.show ?? []);
  const hidden = DASH_CARDS.filter((c) => !shown.has(c));
  await ctx.as((q) => q.query('update user_preferences set dashboard_hidden = $1 where user_id = hearth_uid()', [hidden]));
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

// ───────────── Notification channels (plugins, FR-NOTI-02) — config encrypted with the user's data key ─────────────
post('/settings/channels', { access: 'auth' }, async (ctx) => {
  const plugin = registry.channels.get(ctx.body.kind ?? '');
  if (!plugin) throw new HttpError(422, 'invalid');
  const values = [ctx.body.f1 ?? '', ctx.body.f2 ?? ''];
  const config = Object.fromEntries(plugin.fields.map((f, i) => [f.key, (values[i] ?? '').trim().slice(0, 500)]));
  await ctx.as((q) => q.query('insert into notification_channels(owner_id, kind, label, config_enc) values (hearth_uid(), $1, $2, $3)', [plugin.kind, text(ctx.body.label, 60), cipher(ctx).enc(JSON.stringify(config))]));
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

post('/settings/channels/:id/test', { access: 'auth' }, async (ctx) => {
  const row = await ctx.as((q) => q.one<any>('select kind, config_enc from notification_channels where id = $1', [ctx.params.id]));
  if (!row) throw new HttpError(404);
  const plugin = registry.channels.get(row.kind);
  let error: string | null = null;
  try { await plugin!.send(JSON.parse(cipher(ctx).dec(row.config_enc) || '{}'), { title: 'Hearth', body: ctx.t('settings.channel_test_msg'), url: '/' }); } catch (e) { error = (e as Error).message.slice(0, 200); }
  await ctx.as((q) => q.query('update notification_channels set last_error = $2 where id = $1', [ctx.params.id, error]));
  return redirect(withFlash('/settings', error ? 'err' : 'ok', error ? 'channel_failed' : 'channel_ok'));
});

post('/settings/channels/:id/delete', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('delete from notification_channels where id = $1', [ctx.params.id]));
  return redirect(withFlash('/settings', 'ok', 'deleted'));
});

// ───────────── Web Push subscription API (FR-NOTI-01) ─────────────
get('/api/v1/push/key', { access: 'auth', api: true }, async (ctx) => jsonRes({ publicKey: (await vapid(ctx.db)).publicKey }));

post('/api/v1/push/subscribe', { access: 'auth', api: true }, async (ctx) => {
  const b = (ctx.json ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (typeof b.endpoint !== 'string' || !b.endpoint.startsWith('https://') || b.endpoint.length > 1000 || !/^[\w-]{60,120}$/.test(b.keys?.p256dh ?? '') || !/^[\w-]{16,40}$/.test(b.keys?.auth ?? '')) throw new HttpError(422, 'invalid');
  await ctx.as((q) => q.query(`insert into push_subscriptions(owner_id, endpoint, p256dh, auth, user_agent) values (hearth_uid(), $1, $2, $3, $4)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth where push_subscriptions.owner_id = hearth_uid()`, [b.endpoint, b.keys!.p256dh, b.keys!.auth, ctx.ua.slice(0, 200)]));
  return jsonRes({ ok: true }, 201);
});

post('/api/v1/push/unsubscribe', { access: 'auth', api: true }, async (ctx) => {
  const b = (ctx.json ?? {}) as { endpoint?: string };
  await ctx.as((q) => q.query('delete from push_subscriptions where endpoint = $1 and owner_id = hearth_uid()', [String(b.endpoint ?? '')]));
  return jsonRes({ ok: true });
});

post('/settings/notifications', { access: 'auth' }, async (ctx) => {
  const prefs: Record<string, Record<string, boolean>> = {};
  for (const ty of NOTI_TYPES) { prefs[ty] = {}; for (const c of NOTI_CHANNELS) prefs[ty][c] = ctx.body[`n_${ty}_${c}`] === '1'; }
  await ctx.as((q) => q.query('update user_preferences set notify_prefs = $1 where user_id = hearth_uid()', [JSON.stringify(prefs)]));
  return redirect(withFlash('/settings', 'ok', 'saved'));
});

post('/settings/privacy-toggle', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => q.query('update user_preferences set privacy_mode = not privacy_mode where user_id = hearth_uid()'));
  return redirect(safeNext(ctx.body.next));
});

// ───────────── Security ─────────────
get('/settings/security', { access: 'auth' }, async (ctx) => {
  const f = makeFmt(ctx.prefs, ctx.lang);
  const t = ctx.t;
  const { sessions, log, codesLeft, passkeys, identities, providers, grants, admins } = await ctx.db.system(async (q) => ({
    passkeys: await q.query<any>('select id, name, created_at, last_used_at from webauthn_credentials where user_id = $1 order by created_at', [ctx.user!.id]),
    identities: await q.query<any>('select i.provider_id, i.email, p.name from oidc_identities i join oidc_providers p on p.id = i.provider_id where i.user_id = $1', [ctx.user!.id]),
    providers: await q.query<any>('select id, name from oidc_providers where enabled order by name'),
    grants: await q.query<any>('select g.expires_at, u.display_name, u.email from support_grants g join users u on u.id = g.granted_to where g.user_id = $1 and g.expires_at > now()', [ctx.user!.id]),
    admins: await q.query<any>('select id, display_name, email from users where is_admin and not disabled and id <> $1 order by created_at', [ctx.user!.id]),
    sessions: await q.query<any>('select id, created_at, last_seen_at, ip, user_agent from sessions where user_id = $1 and not mfa_pending order by last_seen_at desc', [ctx.user!.id]),
    log: await q.query<any>(`select at, action, ip from audit_log where user_id = $1 order by id desc limit 30`, [ctx.user!.id]),
    codesLeft: (await q.one<{ n: number }>('select count(*)::int n from recovery_codes where user_id = $1 and used_at is null', [ctx.user!.id]))!.n,
  }));
  const pending = ctx.query.get('setup') === '1';
  let setup = html``;
  if (pending && !ctx.user!.totp_enabled) {
    const u = await ctx.db.system((q) => q.one<any>('select totp_secret_enc from users where id = $1', [ctx.user!.id]));
    const secret = cipher(ctx).dec(u.totp_secret_enc);
    const url = otpauthUrl(secret, ctx.user!.email);
    setup = html`<ol class="steps-list"><li>${t('mfa.step1')}</li><li>${t('mfa.step2')}<a class="totp-qr" href="${url}">${raw(qrSvg(url, t('mfa.qr_label')))}</a>${t('mfa.step2_manual')}<br><code class="secret">${secret.match(/.{1,4}/g)?.join(' ')}</code><br><input class="copy" readonly value="${url}" aria-label="otpauth URL"></li><li>${t('mfa.step3')}</li></ol>
      ${form(ctx, '/settings/security/totp/confirm', field(t('auth.code'), input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 6 }), { id: 'f-code' }), { submit: t('mfa.enable') })}`;
  }
  return htmlRes(page(ctx, {
    title: t('settings.security'),
    scripts: ['webauthn.js'],
    body: html`
      ${card(t('mfa.title'), ctx.user!.totp_enabled
        ? html`<p class="ok-text">${icon('check')} ${t('mfa.on')}</p><p>${t('mfa.codes_left', { n: codesLeft })}</p>
          <div class="row-actions">${postButton(ctx, '/settings/security/recovery', t('mfa.regen_codes'))} ${postButton(ctx, '/settings/security/totp/disable', t('mfa.disable'), { cls: 'danger sm', confirm: t('mfa.confirm_disable') })}</div>`
        : pending ? setup : html`<p>${t('mfa.off')}</p>${postButton(ctx, '/settings/security/totp/start', t('mfa.setup'), { cls: 'primary' })}`)}
      ${card(t('passkey.title'), html`<p class="note">${t('passkey.intro')}</p>
        ${passkeys.length ? html`<ul class="rows">${passkeys.map((k: any) => html`<li><span><strong>${k.name}</strong><small>${t('passkey.added', { date: f.date(k.created_at) })}${k.last_used_at ? html` · ${t('settings.last_seen', { date: f.date(k.last_used_at) })}` : ''}</small></span>${postButton(ctx, `/settings/passkeys/${k.id}/delete`, t('common.remove'), { cls: 'sm link', confirm: t('common.are_you_sure') })}</li>`)}</ul>` : ''}
        <p class="row-actions"><button class="btn primary" type="button" data-passkey-register hidden>${t('passkey.add')}</button> <span data-passkey-status role="status"></span></p>`)}
      ${providers.length || identities.length ? card(t('oidc.title'), html`
        ${identities.length ? html`<ul class="rows">${identities.map((i: any) => html`<li><span><strong>${i.name}</strong><small>${i.email ?? ''}</small></span>${postButton(ctx, `/settings/oidc/${i.provider_id}/unlink`, t('oidc.unlink'), { cls: 'sm link' })}</li>`)}</ul>` : ''}
        <p class="row-actions">${providers.filter((p: any) => !identities.some((i: any) => i.provider_id === p.id)).map((p: any) => html`<a class="btn" href="/auth/oidc/start/${p.id}">${t('oidc.link', { name: p.name })}</a> `)}</p>`) : ''}
      ${admins.length ? card(t('support.title'), html`<p class="note">${t('support.intro')}</p>
        ${grants.length ? html`<ul class="rows">${grants.map((g: any) => html`<li><span>${g.display_name || g.email}</span><small>${t('support.until', { date: f.date(g.expires_at) })}</small></li>`)}</ul>${postButton(ctx, '/settings/support/revoke', t('support.revoke'))}` : ''}
        ${form(ctx, '/settings/support/grant', html`<div class="grid2">${field(t('support.admin'), select('admin_id', admins.map((a: any) => ({ value: a.id, label: a.display_name || a.email })), admins[0].id))}${field(t('support.hours'), input({ name: 'hours', type: 'number', min: 1, max: 72, value: 24 }))}</div>`, { submit: t('support.grant') })}`) : ''}
      ${card(t('settings.password'), form(ctx, '/settings/password', html`
        ${field(t('auth.new_password'), input({ name: 'password', type: 'password', required: true, autocomplete: 'new-password' }), { id: 'f-newpw', hint: t('auth.password_rule') })}`, { submit: t('settings.change_password') }))}
      ${card(t('settings.email_change'), form(ctx, '/settings/email', field(t('settings.new_email'), input({ name: 'email', type: 'email', required: true, autocomplete: 'email' }), { id: 'f-newemail' }), { submit: t('common.save') }))}
      ${card(t('settings.sessions'), html`<ul class="rows">${sessions.map((s) => html`<li><span>${s.id === ctx.session!.id ? html`<strong>${t('settings.this_device')}</strong> · ` : ''}${s.user_agent?.slice(0, 60)}<small>${t('settings.last_seen', { date: f.date(s.last_seen_at) })} · IP ${maskIp(s.ip)}</small></span>
        ${s.id !== ctx.session!.id ? postButton(ctx, `/settings/sessions/revoke`, t('settings.revoke'), { cls: 'sm', fields: { sid: s.id } }) : ''}</li>`)}</ul>
        ${sessions.length > 1 ? postButton(ctx, '/settings/sessions/revoke-others', t('settings.revoke_others')) : ''}`)}
      ${card(t('settings.security_log'), html`<ul class="rows">${log.map((l) => html`<li><span>${f.date(l.at)} ${new Date(l.at).toLocaleTimeString(f.locale, { hour: '2-digit', minute: '2-digit' })} · ${t(`audit.${l.action}`)}</span><small>IP ${maskIp(l.ip)}</small></li>`)}</ul>`)}`,
  }));
});

post('/settings/security/totp/start', { access: 'auth' }, async (ctx) => {
  if (ctx.user!.totp_enabled) return redirect('/settings/security');
  const secret = newTotpSecret();
  await ctx.db.system((q) => q.query('update users set totp_secret_enc = $1 where id = $2', [cipher(ctx).enc(secret), ctx.user!.id]));
  return redirect('/settings/security?setup=1');
});

post('/settings/security/totp/confirm', { access: 'auth' }, async (ctx) => {
  const u = await ctx.db.system((q) => q.one<any>('select totp_secret_enc from users where id = $1', [ctx.user!.id]));
  const step = verifyTotp(cipher(ctx).dec(u.totp_secret_enc), (ctx.body.code ?? '').trim(), null);
  if (step == null) return redirect(withFlash('/settings/security?setup=1', 'err', 'bad_code'));
  const codes = newRecoveryCodes();
  const token = await ctx.db.system(async (q) => {
    await q.query('update users set totp_enabled = true, totp_last_step = $1 where id = $2', [step, ctx.user!.id]);
    await q.query('delete from recovery_codes where user_id = $1', [ctx.user!.id]);
    for (const c of codes) await q.query('insert into recovery_codes(user_id, code_hash) values ($1,$2)', [ctx.user!.id, hashRecoveryCode(c)]);
    await audit(q, 'mfa_enabled', ctx.user!.id, {}, ctx.ip);
    // privilege change → rotate session id (NFR-SEC-05)
    await destroySession(q, ctx.session!.id);
    return (await createSession(q, ctx.user!.id, ctx.ip, ctx.ua, false)).token;
  });
  ctx.setCookies.push(cookie(SESSION_COOKIE, token));
  await securityAlert(ctx.db, ctx.user!.id, 'mfa_enabled', ctx.lang);
  return showCodes(ctx, codes);
});

post('/settings/security/totp/disable', { access: 'auth', stepUp: true }, async (ctx) => {
  await ctx.db.system(async (q) => {
    await q.query('update users set totp_enabled = false, totp_secret_enc = null where id = $1', [ctx.user!.id]);
    await q.query('delete from recovery_codes where user_id = $1', [ctx.user!.id]);
    await audit(q, 'mfa_disabled', ctx.user!.id, {}, ctx.ip);
  });
  await securityAlert(ctx.db, ctx.user!.id, 'mfa_disabled', ctx.lang);
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});

post('/settings/security/recovery', { access: 'auth', stepUp: true }, async (ctx) => {
  const codes = newRecoveryCodes();
  await ctx.db.system(async (q) => {
    await q.query('delete from recovery_codes where user_id = $1', [ctx.user!.id]);
    for (const c of codes) await q.query('insert into recovery_codes(user_id, code_hash) values ($1,$2)', [ctx.user!.id, hashRecoveryCode(c)]);
  });
  return showCodes(ctx, codes);
});

post('/settings/password', { access: 'auth', stepUp: true }, async (ctx) => {
  const problem = await checkPassword(ctx.body.password ?? '', ctx.user!.email);
  if (problem) return redirect(withFlash('/settings/security', 'err', `password_${problem}`));
  const hash = await hashPassword(ctx.body.password);
  const token = await ctx.db.system(async (q) => {
    await q.query('update users set password_hash = $1 where id = $2', [hash, ctx.user!.id]);
    await q.query('delete from sessions where user_id = $1', [ctx.user!.id]);
    await audit(q, 'password_changed', ctx.user!.id, {}, ctx.ip);
    return (await createSession(q, ctx.user!.id, ctx.ip, ctx.ua, false)).token;
  });
  ctx.setCookies.push(cookie(SESSION_COOKIE, token));
  await securityAlert(ctx.db, ctx.user!.id, 'password_changed', ctx.lang);
  return redirect(withFlash('/settings/security', 'ok', 'password_changed'));
});

post('/settings/email', { access: 'auth', stepUp: true }, async (ctx) => {
  const email = text(ctx.body.email, 320, true);
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) throw new HttpError(422, 'invalid');
  const taken = await ctx.db.system((q) => q.one('select 1 from users where lower(email) = lower($1)', [email]));
  if (taken) return redirect(withFlash('/settings/security', 'err', 'email_taken'));
  await securityAlert(ctx.db, ctx.user!.id, 'email_changed', ctx.lang, { email });
  await ctx.db.system(async (q) => {
    await q.query('update users set email = $1, email_verified_at = null where id = $2', [email, ctx.user!.id]);
    await audit(q, 'admin_user', ctx.user!.id, { email_changed: true }, ctx.ip);
  });
  const { sendVerification } = await import('../services/users.ts');
  await sendVerification(ctx.db, ctx.user!.id, email, ctx.lang);
  return redirect(withFlash('/settings/security', 'ok', 'check_email'));
});

post('/settings/sessions/revoke', { access: 'auth' }, async (ctx) => {
  const sid = String(ctx.body.sid ?? '');
  if (!/^[0-9a-f]{64}$/.test(sid)) throw new HttpError(404);
  await ctx.db.system(async (q) => {
    await q.query('delete from sessions where id = $1 and user_id = $2', [sid, ctx.user!.id]);
    await audit(q, 'session_revoked', ctx.user!.id, {}, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});

post('/settings/sessions/revoke-others', { access: 'auth' }, async (ctx) => {
  await ctx.db.system(async (q) => {
    await q.query('delete from sessions where user_id = $1 and id <> $2', [ctx.user!.id, ctx.session!.id]);
    await audit(q, 'session_revoked', ctx.user!.id, { all_others: true }, ctx.ip);
  });
  return redirect(withFlash('/settings/security', 'ok', 'saved'));
});

// ───────────── Export (FR-IO-04, step-up) ─────────────
get('/settings/export', { access: 'auth', stepUp: true }, async (ctx) => htmlRes(page(ctx, {
  title: ctx.t('settings.export'),
  body: card(null, html`<p>${ctx.t('settings.export_intro')}</p>
    <div class="row-actions">${postButton(ctx, '/settings/export/json', ctx.t('settings.export_json'), { cls: 'primary' })} ${postButton(ctx, '/settings/export/csv', ctx.t('settings.export_csv'))}</div>`),
})));

post('/settings/export/json', { access: 'auth', stepUp: true }, async (ctx) => {
  const data = await exportUserData(ctx);
  await ctx.db.system((q) => audit(q, 'export', ctx.user!.id, { format: 'json' }, ctx.ip));
  return download(`hearth-export-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
});

post('/settings/export/csv', { access: 'auth', stepUp: true }, async (ctx) => {
  const data = await exportUserData(ctx);
  await ctx.db.system((q) => audit(q, 'export', ctx.user!.id, { format: 'csv' }, ctx.ip));
  return download(`hearth-transactions-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8', '﻿' + toCsv(data.transactions as any[]));
});

// ───────────── Delete account (FR-SET-06, NFR-SEC-18) ─────────────
post('/settings/delete', { access: 'auth', stepUp: true }, async (ctx) => {
  if ((ctx.body.confirm ?? '').trim() !== 'DELETE') return redirect(withFlash('/settings', 'err', 'confirm_delete'));
  const owns = await ctx.as((q) => q.one(`select 1 from members m where m.user_id = hearth_uid() and m.role = 'owner' and exists (select 1 from members o where o.household_id = m.household_id and o.user_id <> hearth_uid() and o.user_id is not null)`));
  if (owns) return redirect(withFlash('/settings', 'err', 'transfer_first'));
  await requestDeletion(ctx.db, ctx.user!.id, ctx.ip);
  ctx.setCookies.push(cookie(SESSION_COOKIE, '', { maxAge: 0 }));
  return redirect('/login?ok=account_deleted');
});

export const _v = { verifyPassword };
