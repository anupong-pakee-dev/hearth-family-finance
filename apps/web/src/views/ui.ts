import type { Ctx } from '../http/app.ts';
import { html, raw, attrs, type SafeHtml } from './html.ts';
import { csrfField } from './layout.ts';

/**
 * Labelled form field. The label is always tied to the control's own id (WCAG 1.3.1 / Lighthouse "label"),
 * and the hint is linked with aria-describedby.
 */
export function field(label: string, control: SafeHtml, opts: { hint?: string; id?: string } = {}): SafeHtml {
  const own = /<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/.exec(control.__html)?.[1];
  const id = own ?? opts.id;
  let ctl = control;
  if (id && opts.hint && own) ctl = raw(control.__html.replace(`id="${own}"`, `id="${own}" aria-describedby="${own}-hint"`));
  return html`<div class="field"><label${raw(id ? ` for="${id}"` : '')}>${label}</label>${ctl}${opts.hint ? html`<small class="hint"${raw(id ? ` id="${id}-hint"` : '')}>${opts.hint}</small>` : ''}</div>`;
}

type InputOpts = { name: string; type?: string; value?: string | number | null; required?: boolean; placeholder?: string; min?: string | number; max?: string | number; step?: string; inputmode?: string; autocomplete?: string; pattern?: string; maxlength?: number; autofocus?: boolean; readonly?: boolean; list?: string; id?: string };

export function input(o: InputOpts): SafeHtml {
  return html`<input${attrs({ id: o.id ?? `f-${o.name}`, name: o.name, type: o.type ?? 'text', value: o.value == null ? undefined : String(o.value), required: o.required, placeholder: o.placeholder, min: o.min, max: o.max, step: o.step, inputmode: o.inputmode, autocomplete: o.autocomplete ?? 'off', pattern: o.pattern, maxlength: o.maxlength, autofocus: o.autofocus, readonly: o.readonly, list: o.list })}>`;
}

export function moneyInput(name: string, value?: string | null, o: { required?: boolean; placeholder?: string; autofocus?: boolean; id?: string } = {}): SafeHtml {
  return input({ name, value, required: o.required, inputmode: 'decimal', pattern: '-?[0-9,]*\\.?[0-9]{0,2}', placeholder: o.placeholder ?? '0.00', autofocus: o.autofocus, id: o.id });
}

export function rateInput(name: string, value?: string | null, required = false): SafeHtml {
  return input({ name, value, required, inputmode: 'decimal', pattern: '[0-9]*\\.?[0-9]{0,4}', placeholder: '0.00' });
}

export function dateInput(name: string, value?: string | null, required = false): SafeHtml {
  return input({ name, type: 'date', value, required });
}

export function select(name: string, options: { value: string; label: string; group?: string }[], selected?: string | null, o: { required?: boolean; empty?: string; id?: string; autosubmit?: boolean } = {}): SafeHtml {
  const groups = new Map<string, typeof options>();
  for (const op of options) { const g = op.group ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(op); }
  const opt = (op: { value: string; label: string }) => html`<option value="${op.value}" ${op.value === (selected ?? '') ? raw('selected') : ''}>${op.label}</option>`;
  return html`<select${attrs({ id: o.id ?? `f-${name}`, name, required: o.required, 'data-autosubmit': o.autosubmit })}>
    ${o.empty !== undefined ? html`<option value="">${o.empty}</option>` : ''}
    ${[...groups.entries()].map(([g, ops]) => (g ? html`<optgroup label="${g}">${ops.map(opt)}</optgroup>` : ops.map(opt)))}
  </select>`;
}

export function checkbox(name: string, label: string, checked: boolean, value = '1'): SafeHtml {
  return html`<label class="check"><input type="checkbox" name="${name}" value="${value}" ${checked ? raw('checked') : ''}> ${label}</label>`;
}

export function form(ctx: Ctx, action: string, body: SafeHtml, o: { submit?: string; cls?: string; multipart?: boolean; danger?: boolean } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="${o.cls ?? 'stack'}" ${o.multipart ? raw('enctype="multipart/form-data"') : ''}>${csrfField(ctx)}${body}${o.submit ? html`<div class="actions"><button class="btn ${o.danger ? 'danger' : 'primary'}" type="submit">${o.submit}</button></div>` : ''}</form>`;
}

/** Small inline POST button (delete, archive, toggle). */
export function postButton(ctx: Ctx, action: string, label: string, o: { cls?: string; fields?: Record<string, string>; confirm?: string } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline" ${o.confirm ? html`data-confirm="${o.confirm}"` : ''}>${csrfField(ctx)}${Object.entries(o.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="btn ${o.cls ?? 'sm'}" type="submit">${label}</button></form>`;
}

export function card(title: string | null, body: SafeHtml, o: { cls?: string; action?: SafeHtml; id?: string } = {}): SafeHtml {
  return html`<section class="card ${o.cls ?? ''}" ${o.id ? html`id="${o.id}"` : ''}>${title ? html`<div class="card-head"><h2>${title}</h2>${o.action ?? ''}</div>` : ''}${body}</section>`;
}

export function stat(label: string, value: SafeHtml | string, sub?: SafeHtml | string, tone?: 'ok' | 'warn' | 'bad'): SafeHtml {
  return html`<div class="stat ${tone ?? ''}"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong>${sub ? html`<span class="stat-sub">${sub}</span>` : ''}</div>`;
}

export function empty(text: string, action?: SafeHtml): SafeHtml {
  return html`<div class="empty"><p>${text}</p>${action ?? ''}</div>`;
}

export function meter(value: number, max: number, label: string, o: { low?: number; high?: number; optimum?: number } = {}): SafeHtml {
  const v = Math.max(0, Math.min(max, value));
  return html`<meter value="${v.toFixed(4)}" min="0" max="${max}" ${o.low != null ? html`low="${o.low}"` : ''} ${o.high != null ? html`high="${o.high}"` : ''} ${o.optimum != null ? html`optimum="${o.optimum}"` : ''} aria-label="${label}">${(v / (max || 1) * 100).toFixed(0)}%</meter>`;
}

export function pager(ctx: Ctx, page: number, hasNext: boolean): SafeHtml {
  const q = new URLSearchParams(ctx.query);
  const link = (p: number) => { q.set('page', String(p)); return `${ctx.path}?${q.toString()}`; };
  return html`<nav class="pager" aria-label="${ctx.t('a11y.pagination')}">${page > 1 ? html`<a class="btn sm" href="${link(page - 1)}" rel="prev">← ${ctx.t('common.prev')}</a>` : html`<span></span>`}<span>${ctx.t('common.page', { n: page })}</span>${hasNext ? html`<a class="btn sm" href="${link(page + 1)}" rel="next">${ctx.t('common.next')} →</a>` : html`<span></span>`}</nav>`;
}

export function disclaimer(ctx: Ctx, key = 'common.estimate_note'): SafeHtml {
  return html`<p class="note">${ctx.t(key)}</p>`;
}

export function tabs(ctx: Ctx, items: { href: string; label: string }[]): SafeHtml {
  return html`<nav class="tabs">${items.map((i) => html`<a href="${i.href}" ${ctx.url.pathname + ctx.url.search === i.href || ctx.path === i.href ? raw('aria-current="page"') : ''}>${i.label}</a>`)}</nav>`;
}
