/**
 * Server-rendered SVG charts (NFR-PERF-07): no chart JavaScript at all, fixed viewBox so space is
 * reserved (CLS = 0), colours from CSS variables (dark mode), every series also distinguished by
 * pattern (dashed / dotted / markers) and text labels so colour is never the only cue (§4.9).
 */
import { html, raw, esc, type SafeHtml } from './html.ts';

const W = 640;
const H = 260;
const PAD = { l: 64, r: 12, t: 14, b: 34 };

export interface Series { name: string; cls: string; values: (number | null)[]; dashed?: boolean; dotted?: boolean; area?: boolean }

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function legend(series: { name: string; cls: string; dashed?: boolean; dotted?: boolean }[]): SafeHtml {
  return html`<ul class="legend">${series.map((s) => html`<li><svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" class="${s.cls} stroke" stroke-width="3" ${raw(s.dashed ? 'stroke-dasharray="5 3"' : s.dotted ? 'stroke-dasharray="1 3"' : '')}/></svg>${s.name}</li>`)}</ul>`;
}

function frame(title: string, summary: string, inner: string, extra: SafeHtml | string = ''): SafeHtml {
  return html`<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}: ${summary}" preserveAspectRatio="xMidYMid meet"><title>${title}</title><desc>${summary}</desc>${raw(inner)}</svg>${extra}</figure>`;
}

/** Round axis bounds to a "nice" step so ticks land on 0 and on round numbers. */
function niceRange(lo: number, hi: number): { min: number; max: number; step: number } {
  const step = niceMax(Math.max(1e-9, (hi - lo) / 4));
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step || step, step };
}

function axis(min: number, max: number, fmt: (n: number) => string): string {
  const step = niceMax(Math.max(1e-9, (max - min) / 4));
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - min) / (max - min || 1));
  return ticks.map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${PAD.l - 6}" y="${(y(v) + 4).toFixed(1)}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`).join('');
}

function xLabels(labels: string[], every: number): string {
  const n = labels.length;
  const step = (W - PAD.l - PAD.r) / Math.max(1, n);
  return labels.map((l, i) => (i % every === 0 || i === n - 1 ? `<text x="${(PAD.l + step * (i + 0.5)).toFixed(1)}" y="${H - 12}" class="tick" text-anchor="middle">${esc(l)}</text>` : '')).join('');
}

/** Grouped bars + optional line (DASH-01, 19, 21). */
export function barChart(o: { title: string; labels: string[]; bars: Series[]; line?: Series; fmt: (n: number) => string; summary: string; links?: (string | null)[] }): SafeHtml {
  const all = [...o.bars.flatMap((s) => s.values), ...(o.line?.values ?? [])].filter((v): v is number => v != null);
  const { min, max } = niceRange(Math.min(0, ...all), Math.max(0, ...all));
  const plotH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + plotH * (1 - (v - min) / (max - min || 1));
  const n = o.labels.length;
  const step = (W - PAD.l - PAD.r) / Math.max(1, n);
  const bw = Math.max(2, (step * 0.7) / Math.max(1, o.bars.length));
  let inner = axis(min, max, o.fmt);
  o.bars.forEach((s, si) => {
    s.values.forEach((v, i) => {
      if (v == null) return;
      const x = PAD.l + step * i + step * 0.15 + bw * si;
      const y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v));
      const rect = `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y1 - y0).toFixed(1)}" class="${s.cls} fill"><title>${esc(o.labels[i])} · ${esc(s.name)}: ${esc(o.fmt(v))}</title></rect>`;
      const link = o.links?.[i];
      // drill-down (§4.9): bars link to the matching transactions
      inner += link ? `<a href="${esc(link)}" aria-label="${esc(o.labels[i])} · ${esc(s.name)}: ${esc(o.fmt(v))}">${rect}</a>` : rect;
    });
  });
  if (o.line) {
    const pts = o.line.values.map((v, i) => (v == null ? null : `${(PAD.l + step * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    inner += `<polyline points="${pts.join(' ')}" class="${o.line.cls} stroke" fill="none" stroke-width="2.5"/>`;
    o.line.values.forEach((v, i) => { if (v != null) inner += `<circle cx="${(PAD.l + step * (i + 0.5)).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" class="${o.line!.cls} fill"><title>${esc(o.labels[i])} · ${esc(o.line!.name)}: ${esc(o.fmt(v))}</title></circle>`; });
  }
  inner += xLabels(o.labels, n > 8 ? 2 : 1);
  return frame(o.title, o.summary, inner, legend([...o.bars, ...(o.line ? [o.line] : [])]));
}

/** Multi-line / area chart: actual solid, projection dashed (DASH-06, 07, 10, 13, 16, 20). */
export function lineChart(o: { title: string; labels: string[]; series: Series[]; fmt: (n: number) => string; summary: string; band?: { lower: number[]; upper: number[]; cls: string } }): SafeHtml {
  const vals = o.series.flatMap((s) => s.values).concat(o.band ? [...o.band.lower, ...o.band.upper] : []).filter((v): v is number => v != null);
  const { min, max } = niceRange(Math.min(0, ...vals), Math.max(0, ...vals)); // net worth can be negative
  const plotH = H - PAD.t - PAD.b;
  const n = o.labels.length;
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
  const y = (v: number) => PAD.t + plotH * (1 - (v - min) / (max - min || 1));
  let inner = axis(min, max, o.fmt);
  if (o.band) {
    const up = o.band.upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const lo = o.band.lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
    inner += `<polygon points="${[...up, ...lo].join(' ')}" class="${o.band.cls} band"/>`;
  }
  for (const s of o.series) {
    const segs: string[][] = [[]];
    s.values.forEach((v, i) => { if (v == null) { if (segs[segs.length - 1].length) segs.push([]); } else segs[segs.length - 1].push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
    for (const seg of segs) {
      if (!seg.length) continue;
      if (s.area) {
        const first = seg[0].split(',')[0], last = seg[seg.length - 1].split(',')[0];
        inner += `<polygon points="${first},${y(0).toFixed(1)} ${seg.join(' ')} ${last},${y(0).toFixed(1)}" class="${s.cls} area"/>`;
      }
      inner += `<polyline points="${seg.join(' ')}" fill="none" class="${s.cls} stroke" stroke-width="2.5"${s.dashed ? ' stroke-dasharray="7 5"' : s.dotted ? ' stroke-dasharray="1.5 4" stroke-linecap="round"' : ''}/>`;
    }
    const lastIdx = s.values.reduce<number>((acc, v, i) => (v != null ? i : acc), -1);
    if (lastIdx >= 0) inner += `<circle cx="${x(lastIdx).toFixed(1)}" cy="${y(s.values[lastIdx]!).toFixed(1)}" r="3.5" class="${s.cls} fill"><title>${esc(s.name)} · ${esc(o.labels[lastIdx])}: ${esc(o.fmt(s.values[lastIdx]!))}</title></circle>`;
  }
  const every = Math.max(1, Math.ceil(n / 8));
  inner += o.labels.map((l, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 12}" class="tick" text-anchor="middle">${esc(l)}</text>` : '')).join('');
  return frame(o.title, o.summary, inner, legend(o.series));
}

/** Donut with an accessible legend list (DASH-02, 17). */
export function donut(o: { title: string; items: { label: string; value: number; display: string }[]; summary: string; center?: string }): SafeHtml {
  const total = o.items.reduce((s, i) => s + Math.max(0, i.value), 0);
  const R = 70, r = 44, cx = 90, cy = 90;
  let a0 = -Math.PI / 2;
  let paths = '';
  o.items.forEach((it, idx) => {
    const frac = total > 0 ? Math.max(0, it.value) / total : 0;
    if (frac <= 0) return;
    const a1 = a0 + frac * Math.PI * 2 - (frac >= 1 ? 0.0001 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    paths += `<path d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z" class="s${idx % 8} fill"><title>${esc(it.label)}: ${esc(it.display)} (${(frac * 100).toFixed(1)}%)</title></path>`;
    a0 = a1;
  });
  if (!paths) paths = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" class="grid" stroke-width="${R - r}"/>`;
  const center = o.center ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" class="center">${esc(o.center)}</text>` : '';
  const legendList = html`<ol class="donut-legend">${o.items.map((it, idx) => html`<li><span class="sw s${idx % 8} bg" aria-hidden="true"></span><span class="lbl">${it.label}</span><span class="val">${it.display} · ${total > 0 ? ((Math.max(0, it.value) / total) * 100).toFixed(1) : '0'}%</span></li>`)}</ol>`;
  return html`<figure class="chart donut"><svg viewBox="0 0 180 180" role="img" aria-label="${o.title}: ${o.summary}"><title>${o.title}</title>${raw(paths + center)}</svg>${legendList}</figure>`;
}

/** Progress ring (DASH-11). */
export function ring(percent: number, label: string): SafeHtml {
  const p = Math.max(0, Math.min(100, percent));
  const R = 26, C = 2 * Math.PI * R;
  return html`<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${label}: ${p.toFixed(0)}%"><circle cx="32" cy="32" r="${R}" class="ring-bg" fill="none" stroke-width="7"/><circle cx="32" cy="32" r="${R}" class="ring-fg" fill="none" stroke-width="7" stroke-dasharray="${((C * p) / 100).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 32 32)" stroke-linecap="round"/><text x="32" y="36" text-anchor="middle" class="ring-txt">${p.toFixed(0)}%</text></svg>`;
}

/** Emergency fund level vs 1/3/6-month thresholds (DASH-12). */
export function thresholdBar(o: { title: string; months: number; marks: { at: number; label: string }[]; max?: number }): SafeHtml {
  const max = o.max ?? Math.max(7, Math.ceil(Math.min(o.months, 12)) + 1);
  const w = 600, h = 70, x0 = 20;
  const x = (m: number) => x0 + (w - 2 * x0) * Math.min(1, m / max);
  const val = Number.isFinite(o.months) ? o.months : max;
  let inner = `<rect x="${x0}" y="18" width="${w - 2 * x0}" height="18" rx="9" class="track"/><rect x="${x0}" y="18" width="${(x(val) - x0).toFixed(1)}" height="18" rx="9" class="${val >= 6 ? 'ok' : val >= 1 ? 'warn' : 'bad'} fill"/>`;
  for (const mk of o.marks) inner += `<line x1="${x(mk.at)}" x2="${x(mk.at)}" y1="12" y2="42" class="mark" stroke-width="2" stroke-dasharray="3 2"/><text x="${x(mk.at)}" y="58" text-anchor="middle" class="tick">${esc(mk.label)}</text>`;
  return html`<figure class="chart"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${o.title}"><title>${o.title}</title>${raw(inner)}</svg></figure>`;
}

/** Horizontal +/- bars (DASH-18) and stacked bars (DASH-08/09). */
export function hBars(o: { title: string; rows: { label: string; value: number; display: string }[]; summary: string }): SafeHtml {
  const max = Math.max(1, ...o.rows.map((r) => Math.abs(r.value)));
  const rowH = 26, w = 640, mid = 320, h = Math.max(40, o.rows.length * rowH + 10);
  let inner = `<line x1="${mid}" x2="${mid}" y1="0" y2="${h}" class="grid"/>`;
  o.rows.forEach((r, i) => {
    const len = (Math.abs(r.value) / max) * (mid - 150);
    const y = 6 + i * rowH;
    const pos = r.value >= 0;
    inner += `<text x="8" y="${y + 15}" class="tick">${esc(r.label)}</text><rect x="${pos ? mid : mid - len}" y="${y}" width="${Math.max(1, len).toFixed(1)}" height="18" class="${pos ? 'ok' : 'bad'} fill${pos ? '' : ' hatched'}"/><text x="${pos ? mid + len + 6 : mid - len - 6}" y="${y + 14}" class="tick" text-anchor="${pos ? 'start' : 'end'}">${esc(r.display)}</text>`;
  });
  return html`<figure class="chart"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${o.title}: ${o.summary}"><title>${o.title}</title>${raw(inner)}</svg></figure>`;
}

export function stackedBars(o: { title: string; labels: string[]; stacks: Series[]; fmt: (n: number) => string; summary: string }): SafeHtml {
  const totals = o.labels.map((_, i) => o.stacks.reduce((s, st) => s + Math.max(0, st.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + plotH * (1 - v / max);
  const n = o.labels.length;
  const step = (W - PAD.l - PAD.r) / Math.max(1, n);
  let inner = axis(0, max, o.fmt);
  o.labels.forEach((lab, i) => {
    let acc = 0;
    o.stacks.forEach((s, si) => {
      const v = Math.max(0, s.values[i] ?? 0);
      if (!v) return;
      const y1 = y(acc), y0 = y(acc + v);
      inner += `<rect x="${(PAD.l + step * i + step * 0.2).toFixed(1)}" y="${y0.toFixed(1)}" width="${(step * 0.6).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" class="${s.cls} fill"><title>${esc(lab)} · ${esc(s.name)}: ${esc(o.fmt(v))}</title></rect>`;
      acc += v;
    });
  });
  inner += xLabels(o.labels, n > 8 ? 2 : 1);
  return frame(o.title, o.summary, inner, legend(o.stacks));
}

export interface SankeyNode { id: string; label: string; col: 0 | 1 | 2; href?: string }
export interface SankeyLink { from: string; to: string; value: number }

/**
 * Three-column Sankey (DASH-03): income sources → flows (spending / saving / buckets) → spending categories.
 * Pure SVG, node heights proportional to value, labels always rendered as text.
 */
export function sankey(o: { title: string; summary: string; nodes: SankeyNode[]; links: SankeyLink[]; fmt: (n: number) => string }): SafeHtml {
  const w = 640, h = 340, nodeW = 12, gap = 8, colX = [130, 314, 498];
  const value = new Map<string, number>();
  for (const n of o.nodes) {
    const inV = o.links.filter((l) => l.to === n.id).reduce((s, l) => s + l.value, 0);
    const outV = o.links.filter((l) => l.from === n.id).reduce((s, l) => s + l.value, 0);
    value.set(n.id, Math.max(inV, outV));
  }
  const cols = [0, 1, 2].map((c) => o.nodes.filter((n) => n.col === c && (value.get(n.id) ?? 0) > 0));
  const scale = Math.min(...cols.filter((c) => c.length).map((c) => (h - 20 - gap * (c.length - 1)) / Math.max(1e-9, c.reduce((s, n) => s + value.get(n.id)!, 0))));
  const pos = new Map<string, { x: number; y: number; h: number; outY: number; inY: number }>();
  cols.forEach((c, ci) => {
    let y = 10;
    for (const n of c) {
      const nh = Math.max(2, value.get(n.id)! * scale);
      pos.set(n.id, { x: colX[ci], y, h: nh, outY: y, inY: y });
      y += nh + gap;
    }
  });
  let inner = '';
  o.links.forEach((l, i) => {
    const a = pos.get(l.from), b = pos.get(l.to);
    if (!a || !b || l.value <= 0) return;
    const t = l.value * scale;
    const x0 = a.x + nodeW, x1 = b.x, y0 = a.outY + t / 2, y1 = b.inY + t / 2;
    a.outY += t; b.inY += t;
    const mx = (x0 + x1) / 2;
    inner += `<path d="M${x0},${y0.toFixed(1)} C${mx},${y0.toFixed(1)} ${mx},${y1.toFixed(1)} ${x1},${y1.toFixed(1)}" class="s${i % 8} stroke link" fill="none" stroke-width="${Math.max(1, t).toFixed(1)}"><title>${esc(o.nodes.find((n) => n.id === l.from)?.label ?? '')} → ${esc(o.nodes.find((n) => n.id === l.to)?.label ?? '')}: ${esc(o.fmt(l.value))}</title></path>`;
  });
  for (const n of o.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const label = `${n.label} · ${o.fmt(value.get(n.id)!)}`;
    const anchor = n.col === 2 ? 'start' : 'end';
    const tx = n.col === 2 ? p.x + nodeW + 6 : p.x - 6;
    const body = `<rect x="${p.x}" y="${p.y.toFixed(1)}" width="${nodeW}" height="${p.h.toFixed(1)}" class="node"/><text x="${tx}" y="${(p.y + p.h / 2 + 4).toFixed(1)}" text-anchor="${anchor}" class="tick">${esc(label)}</text>`;
    inner += n.href ? `<a href="${esc(n.href)}" aria-label="${esc(label)}">${body}</a>` : body;
  }
  return html`<figure class="chart sankey"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${o.title}: ${o.summary}"><title>${o.title}</title>${raw(inner)}</svg></figure>`;
}

/** Calendar heatmap of daily spending (DASH-15). Each day links to that day's transactions. */
export function calendarHeatmap(o: { title: string; days: { date: string; value: number; display: string }[]; start: string; end: string; weekdayLabels: string[]; monthLabel: (key: string) => string }): SafeHtml {
  const map = new Map(o.days.map((d) => [d.date, d]));
  const vals = o.days.map((d) => d.value).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
  const t = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= t[0] ? 1 : v <= t[1] ? 2 : v <= t[2] ? 3 : 4);
  const cell = 12, gapPx = 3, left = 28, top = 18;
  const s = new Date(`${o.start}T00:00:00Z`), e = new Date(`${o.end}T00:00:00Z`);
  const startDow = s.getUTCDay();
  let inner = '';
  let week = 0, lastMonth = '';
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    week = Math.floor((Math.round((d.getTime() - s.getTime()) / 86_400_000) + startDow) / 7);
    const x = left + week * (cell + gapPx), y = top + dow * (cell + gapPx);
    if (iso.slice(0, 7) !== lastMonth && dow <= 0 + 6) {
      if (d.getUTCDate() <= 7) inner += `<text x="${x}" y="11" class="tick">${esc(o.monthLabel(iso.slice(0, 7)))}</text>`;
      lastMonth = iso.slice(0, 7);
    }
    const it = map.get(iso);
    const lv = level(it?.value ?? 0);
    const rect = `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" class="heat l${lv}"><title>${esc(iso)}: ${esc(it?.display ?? '0')}</title></rect>`;
    inner += it ? `<a href="/transactions?kind=expense&amp;from=${iso}&amp;to=${iso}" aria-label="${esc(iso)}: ${esc(it.display)}">${rect}</a>` : rect;
  }
  [1, 3, 5].forEach((dow) => { inner += `<text x="0" y="${top + dow * (cell + gapPx) + 10}" class="tick">${esc(o.weekdayLabels[dow])}</text>`; });
  const width = left + (week + 1) * (cell + gapPx);
  const legend = [0, 1, 2, 3, 4].map((l, i) => `<rect x="${width - 90 + i * 16}" y="${top + 7 * (cell + gapPx) + 4}" width="${cell}" height="${cell}" rx="2" class="heat l${l}"/>`).join('');
  const height = top + 7 * (cell + gapPx) + 22;
  return html`<figure class="chart heatmap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${o.title}"><title>${o.title}</title>${raw(inner + legend)}</svg></figure>`;
}
