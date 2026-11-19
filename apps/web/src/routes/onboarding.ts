/**
 * Onboarding wizard (NFR-UX-04): income → accounts → debts → buckets? → investing? — every step skippable.
 */
import { get, post, htmlRes, redirect, type Ctx } from '../http/app.ts';
import { html, raw } from '../views/html.ts';
import { page } from '../views/layout.ts';
import { field, input, moneyInput, rateInput, select, form, postButton } from '../views/ui.ts';
import { money, rate, text, oneOf, intIn, cipher } from '../services/common.ts';
import { createAccount, createDebt, applyBucketTemplate, setBucketMode, ACCOUNT_TYPES, DEBT_TYPES, INTEREST_METHODS } from '../services/finance.ts';
import { annuityPayment } from '@hearth/engine';
import { inputMoney } from '../views/format.ts';

const STEPS = ['income', 'accounts', 'debts', 'buckets', 'invest'] as const;

function progress(ctx: Ctx, i: number) {
  return html`<ol class="steps" aria-label="${ctx.t('onb.progress')}">${STEPS.map((s, idx) => html`<li class="${idx < i ? 'done' : idx === i ? 'now' : ''}" ${idx === i ? raw('aria-current="step"') : ''}>${ctx.t(`onb.step.${s}`)}</li>`)}</ol>`;
}

function skip(ctx: Ctx, i: number) {
  return html`<p class="skip-row">${postButton(ctx, `/onboarding/skip?step=${i}`, ctx.t('onb.skip'), { cls: 'link' })}</p>`;
}

get('/onboarding', { access: 'auth' }, async (ctx) => {
  const i = intIn(ctx.query.get('step') ?? '0', 0, STEPS.length - 1, 0);
  const step = STEPS[i];
  const p = ctx.prefs!;
  let body;
  if (step === 'income') {
    body = form(ctx, '/onboarding/income', html`
      <p>${ctx.t('onb.income_intro')}</p>
      ${field(ctx.t('onb.monthly_income'), moneyInput('income', p.monthly_income ? inputMoney(p.monthly_income) : '', { autofocus: true }), { id: 'f-income' })}
      ${field(ctx.t('settings.month_start'), input({ name: 'start_day', type: 'number', min: 1, max: 28, value: p.month_start_day }), { id: 'f-start_day', hint: ctx.t('settings.month_start_hint') })}`, { submit: ctx.t('onb.next') });
  } else if (step === 'accounts') {
    const accounts = await ctx.as((q) => q.query<any>('select name, type, balance from accounts where owner_id = hearth_uid() order by created_at'));
    body = html`<p>${ctx.t('onb.accounts_intro')}</p>
      ${accounts.length ? html`<ul class="plain">${accounts.map((a) => html`<li>✓ ${a.name} · ${ctx.t(`account.type.${a.type}`)}</li>`)}</ul>` : ''}
      ${form(ctx, '/onboarding/accounts', html`<div class="grid3">
        ${field(ctx.t('account.name'), input({ name: 'name', required: true, placeholder: ctx.t('onb.account_placeholder') }), { id: 'f-name' })}
        ${field(ctx.t('account.type'), select('type', ACCOUNT_TYPES.map((v) => ({ value: v, label: ctx.t(`account.type.${v}`) })), 'savings'))}
        ${field(ctx.t('account.balance'), moneyInput('opening', '', { required: false }), { id: 'f-opening', hint: ctx.t('account.balance_hint') })}</div>`, { submit: ctx.t('onb.add_account') })}
      <p class="actions"><a class="btn primary" href="/onboarding?step=2">${ctx.t('onb.next')}</a></p>`;
  } else if (step === 'debts') {
    const debts = await ctx.as((q) => q.query<any>('select name from debts where owner_id = hearth_uid()'));
    body = html`<p>${ctx.t('onb.debts_intro')}</p>
      ${debts.length ? html`<ul class="plain">${debts.map((d) => html`<li>✓ ${d.name}</li>`)}</ul>` : ''}
      ${form(ctx, '/onboarding/debts', html`<div class="grid3">
        ${field(ctx.t('debt.name'), input({ name: 'name', required: true }), { id: 'f-name' })}
        ${field(ctx.t('debt.type'), select('type', DEBT_TYPES.map((v) => ({ value: v, label: ctx.t(`debt.type.${v}`) })), 'personal_loan'))}
        ${field(ctx.t('debt.method'), select('method', INTEREST_METHODS.map((v) => ({ value: v, label: ctx.t(`debt.method.${v}`) })), 'reducing'))}
        ${field(ctx.t('debt.balance'), moneyInput('balance', '', { required: true }), { id: 'f-balance' })}
        ${field(ctx.t('debt.rate'), rateInput('rate'), { id: 'f-rate', hint: ctx.t('debt.rate_hint') })}
        ${field(ctx.t('debt.payment'), moneyInput('payment', ''), { id: 'f-payment', hint: ctx.t('debt.payment_hint') })}</div>`, { submit: ctx.t('onb.add_debt') })}
      <p class="actions"><a class="btn primary" href="/onboarding?step=3">${ctx.t('onb.next')}</a></p>`;
  } else if (step === 'buckets') {
    body = form(ctx, '/onboarding/buckets', html`
      <p>${ctx.t('onb.buckets_intro')}</p>
      <fieldset class="choices"><legend class="sr-only">${ctx.t('settings.bucket_mode')}</legend>
      ${(['off', 'partial', 'full'] as const).map((m) => html`<label class="choice"><input type="radio" name="mode" value="${m}" ${p.bucket_mode === m ? raw('checked') : ''}><span><strong>${ctx.t(`bucket.mode.${m}`)}</strong><small>${ctx.t(`bucket.mode.${m}_desc`)}</small></span></label>`)}
      </fieldset>
      ${field(ctx.t('bucket.template'), select('template', [
        { value: '', label: ctx.t('bucket.tpl_none') },
        { value: 'save_emergency_invest', label: ctx.t('bucket.tpl.save_emergency_invest_name') },
        { value: '50_30_20', label: '50/30/20' },
        { value: 'six_jars', label: ctx.t('bucket.tpl.six_jars_name') },
        { value: 'pay_yourself_first', label: ctx.t('bucket.tpl.pay_yourself_first_name') },
      ], ''), { hint: ctx.t('bucket.template_hint') })}`, { submit: ctx.t('onb.next') });
  } else {
    body = form(ctx, '/onboarding/invest', html`
      <p>${ctx.t('onb.invest_intro')}</p>
      <fieldset class="choices"><legend class="sr-only">${ctx.t('settings.investment')}</legend>
        <label class="choice"><input type="radio" name="invest" value="yes" ${p.investment_enabled ? raw('checked') : ''}><span><strong>${ctx.t('onb.invest_yes')}</strong></span></label>
        <label class="choice"><input type="radio" name="invest" value="no" ${p.investment_enabled === false ? raw('checked') : ''}><span><strong>${ctx.t('onb.invest_no')}</strong></span></label>
      </fieldset>
      <p class="note">${ctx.t('invest.disclaimer')}</p>`, { submit: ctx.t('onb.finish') });
  }
  return htmlRes(page(ctx, { title: ctx.t('onb.title'), body: html`<section class="card onboarding">${progress(ctx, i)}<h2>${ctx.t(`onb.step.${step}`)}</h2>${body}${skip(ctx, i)}</section>` }));
});

post('/onboarding/skip', { access: 'auth' }, async (ctx) => {
  const i = intIn(ctx.query.get('step') ?? '0', 0, STEPS.length - 1, 0);
  if (i >= STEPS.length - 1) {
    await ctx.as((q) => q.query('update user_preferences set onboarded = true where user_id = hearth_uid()'));
    return redirect('/');
  }
  return redirect(`/onboarding?step=${i + 1}`);
});

post('/onboarding/income', { access: 'auth' }, async (ctx) => {
  const income = money(ctx.body.income) ?? 0n;
  const day = intIn(ctx.body.start_day, 1, 28, 1);
  await ctx.as((q) => q.query('update user_preferences set monthly_income = $1, month_start_day = $2 where user_id = hearth_uid()', [income, day]));
  return redirect('/onboarding?step=1');
});

post('/onboarding/accounts', { access: 'auth' }, async (ctx) => {
  await ctx.as((q) => createAccount(q, ctx.user!.id, { name: text(ctx.body.name, 80, true), type: oneOf(ctx.body.type, ACCOUNT_TYPES), opening: money(ctx.body.opening, { allowNegative: true }) ?? 0n }));
  return redirect('/onboarding?step=1');
});

post('/onboarding/debts', { access: 'auth' }, async (ctx) => {
  const balance = money(ctx.body.balance, { required: true })!;
  const method = oneOf(ctx.body.method, INTEREST_METHODS);
  const r = method === 'none' ? 0 : rate(ctx.body.rate);
  const payment = money(ctx.body.payment) ?? annuityPayment(balance, r, 60);
  const c = cipher(ctx);
  await ctx.as((q) => createDebt(q, ctx.user!.id, { name: text(ctx.body.name, 80, true), type: oneOf(ctx.body.type, DEBT_TYPES), principal: balance, balance, method, rateE4: r, payment, creditorEnc: c.enc(null) }));
  return redirect('/onboarding?step=2');
});

post('/onboarding/buckets', { access: 'auth' }, async (ctx) => {
  const mode = oneOf(ctx.body.mode, ['off', 'partial', 'full'] as const, 'off');
  await ctx.as(async (q) => {
    await setBucketMode(q, mode);
    if (mode !== 'off' && ctx.body.template) await applyBucketTemplate(q, ctx.user!.id, ctx.body.template, ctx.t);
  });
  return redirect('/onboarding?step=4');
});

post('/onboarding/invest', { access: 'auth' }, async (ctx) => {
  const yes = ctx.body.invest === 'yes';
  await ctx.as((q) => q.query('update user_preferences set investment_enabled = $1, onboarded = true where user_id = hearth_uid()', [yes]));
  return redirect('/?ok=welcome');
});
