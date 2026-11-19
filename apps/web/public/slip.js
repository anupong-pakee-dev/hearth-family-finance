// FR-TXN-06: read a Thai bank transfer slip photo ON THE DEVICE and pre-fill amount, date, payee and reference.
// Text recognition (tesseract.js, Thai + English) runs in a Web Worker in this browser: the image is never uploaded
// or stored, and the file input has no `name`, so it is never part of the form submission.
// The OCR engine is downloaded only when the user picks a slip (then cached). Loaded only on the new-transaction form.

const MONTHS_TH = ['มค', 'กพ', 'มีค', 'เมย', 'พค', 'มิย', 'กค', 'สค', 'กย', 'ตค', 'พย', 'ธค'];
const MONTHS_TH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const AMOUNT_KEY = /จำนวน|ยอด(เงิน|โอน|ชำระ|รวม)|amount|total/;
const SKIP_KEY = /ค่าธรรมเนียม|fee|คงเหลือ|balance|ส่วนลด|discount|ภาษี|vat/;
const REF_KEY = /เลขที่รายการ|รหัสอ้างอิง|เลขที่อ้างอิง|หมายเลขอ้างอิง|รหัสรายการ|transactionid|referenceno|reference|refno|ref/;
const TO_KEY = /^(ไปยัง|ถึง|ผู้รับเงิน|ผู้รับ|โอนให้|to|recipient|payee)[:.]?/i;
const NAME_PREFIX = /^(นางสาว|นาย|นาง|น\.ส\.?|ด\.ช\.?|ด\.ญ\.?|บจก\.?|บมจ\.?|หจก\.?|บริษัท|ร้าน|mrs\.?|mr\.?|ms\.?|miss)(\s|$)/i;
const MONEY = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g;

/** OCR text → trimmed lines with Arabic digits, composed SARA AM and no stray spaces inside numbers. */
function lines(text) {
  return String(text || '')
    .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/\u0e4d\u0e32/g, '\u0e33') // นิคหิต + สระอา → สระอำ
    .replace(/[\u200b\u00a0]/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').replace(/(\d)\s*([,.])\s*(?=\d)/g, '$1$2').trim())
    .filter(Boolean);
}

const compact = (l) => l.replace(/\s+/g, '').toLowerCase();

function moneyIn(line) {
  const out = [];
  for (const m of line.matchAll(MONEY)) { const v = `${m[1].replace(/,/g, '')}.${m[2]}`; if (Number(v) > 0) out.push(v); }
  return out;
}

function findAmount(ls) {
  const skip = (l) => SKIP_KEY.test(compact(l));
  for (let i = 0; i < ls.length; i++) {
    if (!AMOUNT_KEY.test(compact(ls[i])) || skip(ls[i])) continue;
    const here = moneyIn(ls[i]);
    if (here.length) return here[0];
    if (ls[i + 1] && !skip(ls[i + 1])) { const next = moneyIn(ls[i + 1]); if (next.length) return next[0]; }
  }
  for (const l of ls) if (!skip(l) && /บาท|thb|฿/i.test(l)) { const v = moneyIn(l); if (v.length) return v[0]; }
  const all = ls.filter((l) => !skip(l)).flatMap(moneyIn);
  return all.length ? all.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : undefined;
}

function toIso(y, m, d) {
  if (y < 100) y = y >= 50 ? 2500 + y - 543 : 2000 + y; // 2-digit years on Thai slips are Buddhist era ("69" = 2569)
  else if (y > 2400) y -= 543;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : undefined;
}

function monthOf(token) {
  const t = token.replace(/[\s.]/g, '').toLowerCase();
  if (!t) return 0;
  let i = MONTHS_TH.indexOf(t);
  if (i < 0) i = MONTHS_TH_FULL.indexOf(t);
  if (i < 0 && /^[a-z]{3,9}$/.test(t)) i = MONTHS_EN.indexOf(t.slice(0, 3));
  return i + 1;
}

function findDate(ls) {
  for (const l of ls) {
    for (const m of l.matchAll(/(?<!\d)(\d{1,2})\s*([^\d\s:/-][^\d:/-]{0,16}?)\s*((?:25|20)?\d{2})(?!\d)/g)) {
      const mo = monthOf(m[2]);
      const iso = mo && toIso(Number(m[3]), mo, Number(m[1]));
      if (iso) return iso;
    }
    const n = /(?<![\d.,])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d.,])/.exec(l);
    if (n) { const iso = toIso(Number(n[3]), Number(n[2]), Number(n[1])); if (iso) return iso; }
  }
  return undefined;
}

function findRef(ls) {
  for (let i = 0; i < ls.length; i++) {
    const c = compact(ls[i]);
    const k = REF_KEY.exec(c);
    if (!k) continue;
    const tail = c.slice(k.index + k[0].length).replace(/^[:.#]+/, '');
    for (const s of [tail, compact(ls[i + 1] ?? '')]) {
      const m = /^[a-z0-9]{8,40}/i.exec(s);
      if (m && /\d/.test(m[0])) return m[0].toUpperCase();
    }
  }
  return undefined;
}

function cleanName(s) {
  const name = s.replace(/^[:.\-\s]+/, '').replace(/\s*[xX*\d][xX*\d-]{5,}.*$/, '').trim();
  return (name.match(/[A-Za-z\u0e01-\u0e2e]/g)?.length ?? 0) >= 2 ? name.slice(0, 120) : undefined;
}

function findPayee(ls) {
  for (let i = 0; i < ls.length; i++) {
    const m = TO_KEY.exec(ls[i]);
    if (!m) continue;
    const name = cleanName(ls[i].slice(m[0].length)) ?? (ls[i + 1] ? cleanName(ls[i + 1]) : undefined);
    if (name) return name;
  }
  // No labels (e.g. K PLUS): the sender's name comes first, the recipient's second.
  const names = ls.filter((l) => NAME_PREFIX.test(l)).map(cleanName).filter(Boolean);
  return names.length >= 2 ? names[1] : undefined;
}

/** Pull { amount, date (ISO), payee, ref } out of OCR text from a Thai bank slip; missing fields are undefined. */
export function parseSlipText(text) {
  const ls = lines(text);
  return { amount: findAmount(ls), date: findDate(ls), payee: findPayee(ls), ref: findRef(ls) };
}

// ───────────── browser wiring ─────────────
const box = typeof document === 'undefined' ? null : document.querySelector('[data-slip]');
if (box && box instanceof HTMLElement && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined') setup(box);

/** Trusted Types: allow exactly the same-origin OCR worker script and nothing else. */
function trustWorker(workerUrl) {
  const tt = window.trustedTypes;
  if (!tt || tt.defaultPolicy) return;
  tt.createPolicy('default', {
    createScriptURL: (u) => { if (new URL(u, location.href).href === workerUrl) return u; throw new TypeError('blocked script URL'); },
  });
}

/** Decode and scale the photo to a size OCR reads well; the pixels stay in this tab's memory only. */
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const long = Math.max(bmp.width, bmp.height);
  const scale = long > 2400 ? 2400 / long : long < 1200 ? 1200 / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

function setup(el) {
  const input = el.querySelector('input[type=file]');
  const status = el.querySelector('[role=status]');
  if (!(input instanceof HTMLInputElement) || !status) return;
  const base = el.dataset.ocr ?? '';
  const say = (key, vars = {}) => { status.textContent = (el.dataset[key] ?? '').replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? ''); };
  el.hidden = false;

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    input.disabled = true;
    el.setAttribute('aria-busy', 'true');
    say('msgReading');
    let worker;
    try {
      const workerPath = new URL(base + 'worker.min.js', location.href).href;
      trustWorker(workerPath);
      const { default: Tesseract } = await import(base + 'tesseract.esm.min.js');
      const [img, w] = await Promise.all([prepare(file), Tesseract.createWorker(['tha', 'eng'], 1, {
        workerPath, corePath: base + 'core', langPath: base + 'lang', workerBlobURL: false, cacheMethod: 'none', gzip: true,
      })]);
      worker = w;
      const { data } = await worker.recognize(img);
      img.width = img.height = 0; // drop the pixels
      const filled = fill(el, parseSlipText(data.text));
      if (filled.length) say('msgDone', { fields: filled.join(', ') });
      else say('msgNone');
    } catch {
      say('msgFail');
    } finally {
      if (worker) await worker.terminate().catch(() => {});
      input.value = ''; // forget the file
      input.disabled = false;
      el.removeAttribute('aria-busy');
    }
  });
}

function fill(el, found) {
  const done = [];
  const set = (id, value, label) => {
    const f = document.getElementById(id);
    if (!value || !(f instanceof HTMLInputElement)) return;
    f.value = value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    done.push(label);
  };
  set('f-amount', found.amount, el.dataset.lAmount);
  set('f-date', found.date, el.dataset.lDate);
  set('f-payee', found.payee, el.dataset.lPayee);
  const note = document.getElementById('f-note');
  if (found.ref && note instanceof HTMLTextAreaElement && !note.value.includes(found.ref)) {
    note.value = `${note.value ? note.value + '\n' : ''}Ref: ${found.ref}`;
    done.push(el.dataset.lRef);
  }
  if (done.length) document.getElementById('f-amount')?.focus();
  return done;
}
