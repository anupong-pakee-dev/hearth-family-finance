// FR-TXN-06: read a PromptPay / Thai bank-slip QR code from a photo and pre-fill the form.
// Runs entirely in the browser (BarcodeDetector) — the image never leaves the device.
// Loaded only on the transaction form (code splitting, NFR-PERF-08).

/** Parse EMVCo TLV ("ID(2) LEN(2) VALUE") into a map; nested templates are parsed on demand. */
export function tlv(s) {
  const out = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2);
    const len = Number.parseInt(s.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len)) break;
    out[id] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** Returns { amount?, payee?, ref? } from a PromptPay (EMVCo) payload or a Thai slip verification QR. */
export function parsePayload(text) {
  const t = String(text || '').trim();
  const top = tlv(t);
  if (t.startsWith('000201')) {
    // PromptPay / Thai QR payment: 54 = amount, 59 = merchant name, 29/30 = PromptPay / bill payment
    return { amount: top['54'], payee: top['59'] || undefined, ref: (top['30'] && tlv(top['30'])['02']) || undefined };
  }
  if (top['00']) {
    // Slip verification mini-QR: 00 → { 01 API id, 02 sending bank, 03 transaction ref }
    const inner = tlv(top['00']);
    if (inner['03']) return { ref: inner['03'] };
  }
  return {};
}

const input = typeof document === 'undefined' ? null : document.querySelector('input[data-qr]');
if (input && typeof HTMLInputElement !== 'undefined' && input instanceof HTMLInputElement) {
  if (!('BarcodeDetector' in window)) {
    input.closest('.field')?.setAttribute('hidden', '');
  } else {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const codes = await detector.detect(await createImageBitmap(file));
        const data = parsePayload(codes[0] && codes[0].rawValue);
        const set = (sel, v) => { const el = document.querySelector(sel); if (el && v && !el.value) el.value = v; };
        set('#f-amount', data.amount);
        set('#f-payee', data.payee);
        if (data.ref) { const note = document.querySelector('#f-note'); if (note instanceof HTMLTextAreaElement) note.value = `${note.value ? note.value + '\n' : ''}Ref: ${data.ref}`; }
        input.setCustomValidity('');
      } catch {
        input.setCustomValidity('QR not found');
        input.reportValidity();
      }
    });
  }
}
