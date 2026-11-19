import type { Ctx } from '../http/app.ts';
import { asset, assetSource } from '../http/static.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { cssFor } from '../../public/theme-colors.js';

export function icon(name: string, label?: string): SafeHtml {
  return html`<svg class="ic" ${raw(label ? `role="img" aria-label="${label.replace(/"/g, '')}"` : 'aria-hidden="true"')}><use href="${asset('icons.svg')}#${name}"/></svg>`;
}

export function csrfField(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

function flash(ctx: Ctx): SafeHtml {
  const ok = ctx.query.get('ok');
  const err = ctx.query.get('err');
  return html`${ok ? html`<p class="flash ok" role="status">${ctx.t(`flash.${ok}`)}</p>` : ''}${err ? html`<p class="flash err" role="alert">${ctx.t(`error.${err}`)}</p>` : ''}`;
}

interface NavItem { href: string; key: string; icon: string; show?: boolean }

function navItems(ctx: Ctx): NavItem[] {
  const p = ctx.prefs;
  return [
    { href: '/', key: 'nav.dashboard', icon: 'home' },
    { href: '/transactions', key: 'nav.transactions', icon: 'list' },
    { href: '/buckets', key: 'nav.buckets', icon: 'jar', show: !!p && p.bucket_mode !== 'off' },
    { href: '/analytics', key: 'nav.analytics', icon: 'chart' },
    { href: '/budget', key: 'nav.budget', icon: 'gauge' },
    { href: '/debts', key: 'nav.debts', icon: 'debt' },
    { href: '/goals', key: 'nav.goals', icon: 'target' },
    { href: '/emergency', key: 'nav.emergency', icon: 'shield' },
    { href: '/invest', key: 'nav.invest', icon: 'chart', show: !!p?.investment_enabled },
    { href: '/accounts', key: 'nav.accounts', icon: 'bank' },
    { href: '/recurring', key: 'nav.recurring', icon: 'repeat' },
    { href: '/household', key: 'nav.household', icon: 'users' },
    { href: '/reports', key: 'nav.reports', icon: 'doc' },
    { href: '/calculator', key: 'nav.calculator', icon: 'calc' },
    { href: '/currency', key: 'nav.currency', icon: 'fx' },
    { href: '/settings', key: 'nav.settings', icon: 'gear' },
  ].filter((i) => i.show !== false);
}

function isActive(ctx: Ctx, href: string) {
  return href === '/' ? ctx.path === '/' : ctx.path === href || ctx.path.startsWith(href + '/');
}

/** The person's own palette (Settings › Colours & theme) as CSS variables; nothing when they use the default. */
function userColors(ctx: Ctx): SafeHtml {
  const css = cssFor(ctx.prefs?.colors ?? {}); // values are validated #rrggbb only
  return css ? html`<style nonce="${ctx.nonce}">${raw(css)}</style>` : html``;
}

function head(ctx: Ctx, title: string, scripts: string[] = []): SafeHtml {
  const theme = ctx.prefs?.theme ?? 'system';
  return html`<!doctype html>
<html lang="${ctx.lang}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Hearth</title>
<meta name="description" content="${ctx.t('app.tagline')}">
<meta name="theme-color" content="#f5f3ee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151a18" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style nonce="${ctx.nonce}">${raw(assetSource('app.css'))}</style>
${userColors(ctx)}
<script type="module" nonce="${ctx.nonce}" src="${asset('app.js')}"></script>
${scripts.map((s) => html`<script type="module" nonce="${ctx.nonce}" src="${asset(s)}"></script>`)}
</head>`;
}

/** `scripts`: extra per-page modules (code splitting, NFR-PERF-08) — e.g. qr.js only on the transaction form. */
export function page(ctx: Ctx, o: { title: string; body: SafeHtml; actions?: SafeHtml; wide?: boolean; scripts?: string[] }): SafeHtml {
  if (!ctx.user || !ctx.session || ctx.session.mfa_pending) return guestPage(ctx, o);
  const items = navItems(ctx);
  // Bottom bar (phones): two tabs, the add button, one tab, then "more" — five even slots.
  const primary = ['/', '/transactions', '/goals'];
  const hh = ctx.households.length > 0;
  // calc.js on every signed-in page: amount fields accept maths such as 120+45 (progressive enhancement)
  return html`${head(ctx, o.title, [...new Set([...(o.scripts ?? []), 'calc.js'])])}
<body class="${ctx.prefs?.privacy_mode ? 'privacy' : ''}">
<a class="skip" href="#main">${ctx.t('a11y.skip')}</a>
<header class="top">
  <a class="brand" href="/" aria-label="Hearth">${icon('logo')}<span>Hearth</span></a>
  <div class="top-actions">
    ${hh ? html`<form method="post" action="/view" class="view-switch">${csrfField(ctx)}<input type="hidden" name="next" value="${ctx.path}">
      <label class="sr-only" for="view-sel">${ctx.t('view.label')}</label>
      <select id="view-sel" name="view" data-autosubmit>
        ${(['mine', 'household', 'all'] as const).map((v) => html`<option value="${v}" ${ctx.view === v ? raw('selected') : ''}>${ctx.t(`view.${v}`)}</option>`)}
      </select><noscript><button class="btn sm">${ctx.t('common.apply')}</button></noscript></form>` : ''}
    <form method="post" action="/settings/privacy-toggle">${csrfField(ctx)}<input type="hidden" name="next" value="${ctx.url.pathname + ctx.url.search}">
      <button class="icon-btn" aria-pressed="${ctx.prefs?.privacy_mode ? 'true' : 'false'}" title="${ctx.t('settings.privacy_mode')}">${icon(ctx.prefs?.privacy_mode ? 'eye-off' : 'eye', ctx.t('settings.privacy_mode'))}</button></form>
    <a class="icon-btn badge-wrap" href="/notifications" title="${ctx.t('nav.notifications')}">${icon('bell', ctx.t('nav.notifications'))}${ctx.unread ? html`<span class="badge">${ctx.unread > 99 ? '99+' : ctx.unread}</span>` : ''}</a>
    <form method="post" action="/logout">${csrfField(ctx)}<button class="icon-btn" title="${ctx.t('auth.logout')}">${icon('logout', ctx.t('auth.logout'))}</button></form>
  </div>
</header>
<div class="shell">
<nav class="side" aria-label="${ctx.t('a11y.main_nav')}"><ul>
  ${items.map((i) => html`<li><a href="${i.href}" ${isActive(ctx, i.href) ? raw('aria-current="page"') : ''}>${icon(i.icon)}<span>${ctx.t(i.key)}</span></a></li>`)}
  ${ctx.user.is_admin ? html`<li><a href="/admin" ${isActive(ctx, '/admin') ? raw('aria-current="page"') : ''}>${icon('lock')}<span>${ctx.t('nav.admin')}</span></a></li>` : ''}
</ul></nav>
<main id="main" class="${o.wide ? 'wide' : ''}">
  <div class="page-head"><h1>${o.title}</h1>${o.actions ?? ''}</div>
  ${flash(ctx)}
  ${o.body}
</main>
</div>
<nav class="bottom" aria-label="${ctx.t('a11y.quick_nav')}">
  ${items.filter((i) => primary.includes(i.href)).slice(0, 2).map((i) => html`<a href="${i.href}" ${isActive(ctx, i.href) ? raw('aria-current="page"') : ''}>${icon(i.icon)}<span>${ctx.t(i.key)}</span></a>`)}
  <a href="/transactions/new" class="fab" aria-label="${ctx.t('txn.quick_add')}">${icon('plus')}</a>
  ${items.filter((i) => primary.includes(i.href)).slice(2).map((i) => html`<a href="${i.href}" ${isActive(ctx, i.href) ? raw('aria-current="page"') : ''}>${icon(i.icon)}<span>${ctx.t(i.key)}</span></a>`)}
  <a href="/more" ${ctx.path === '/more' ? raw('aria-current="page"') : ''}>${icon('menu')}<span>${ctx.t('nav.more')}</span></a>
</nav>
</body></html>`;
}

export function guestPage(ctx: Ctx, o: { title: string; body: SafeHtml; scripts?: string[] }): SafeHtml {
  return html`${head(ctx, o.title, o.scripts)}
<body class="guest">
<main id="main" class="guest-main">
  <a class="brand big" href="/" aria-label="Hearth Family Finance">${icon('logo')}<span>Hearth <small>Family Finance</small></span></a>
  <p class="tagline">${ctx.t('app.tagline')}</p>
  <section class="card guest-card"><h1>${o.title}</h1>${flash(ctx)}${o.body}</section>
  <p class="foot"><a href="/lang?l=${ctx.lang === 'th' ? 'en' : 'th'}">${ctx.lang === 'th' ? 'English' : 'ภาษาไทย'}</a> · <a href="https://github.com/hearth-family-finance/hearth-family-finance" rel="noopener">Open source · MIT</a></p>
</main>
</body></html>`;
}

export function navMore(ctx: Ctx): SafeHtml {
  return html`<ul class="more-list">${navItems(ctx).map((i) => html`<li><a href="${i.href}">${icon(i.icon)}<span>${ctx.t(i.key)}</span></a></li>`)}
  ${ctx.user?.is_admin ? html`<li><a href="/admin">${icon('lock')}<span>${ctx.t('nav.admin')}</span></a></li>` : ''}
  <li><a href="/notifications">${icon('bell')}<span>${ctx.t('nav.notifications')}</span></a></li></ul>`;
}
