// CSV column presets for Thai bank statements and other money apps (FR-IO-02, FR-IO-06).
// Community-maintained: add a bank or app by appending an entry with header regexes (case-insensitive).
import type { Registry, ImportPreset } from '../apps/web/src/services/plugins.ts';

export const presets: ImportPreset[] = [
  { id: 'th-bank-generic', name: 'ธนาคารไทย (วันที่ / รายการ / ถอน / ฝาก)', columns: { date: 'วันที่|date', payee: 'รายการ|รายละเอียด|description', withdrawal: 'ถอน|withdraw|debit', deposit: 'ฝาก|deposit|credit', note: 'หมายเหตุ|ช่องทาง|channel' } },
  { id: 'kbank', name: 'KBank (K PLUS statement)', columns: { date: 'วันที่|date', payee: 'รายละเอียด|รายการ|details', withdrawal: 'ถอนเงิน|withdrawal', deposit: 'ฝากเงิน|deposit', note: 'ช่องทาง|channel' } },
  { id: 'scb', name: 'SCB (SCB EASY statement)', columns: { date: 'date|วันที่', payee: 'description|รายการ', withdrawal: 'withdrawal|ถอน', deposit: 'deposit|ฝาก', note: 'channel|ช่องทาง' } },
  { id: 'ktb', name: 'Krungthai (Krungthai NEXT)', columns: { date: 'วันที่|date', payee: 'รายการ|transaction', withdrawal: 'ถอน|debit', deposit: 'ฝาก|credit', note: 'สาขา|branch' } },
  { id: 'bbl', name: 'Bangkok Bank (Bualuang mBanking)', columns: { date: 'date|วันที่', payee: 'description|รายการ', withdrawal: 'debit|ถอน', deposit: 'credit|ฝาก' } },
  { id: 'money-lover', name: 'Money Lover export', columns: { date: '^date$', amount: '^amount$', category: '^category$', note: '^note$' } },
  { id: 'ynab', name: 'YNAB register export', columns: { date: '^date$', payee: '^payee$', category: '^category$', note: '^memo$', withdrawal: '^outflow$', deposit: '^inflow$' } },
  { id: 'firefly', name: 'Firefly III export', columns: { date: '^date$', amount: '^amount$', payee: '^description$', category: '^category$', note: '^notes$' } },
];

export default {
  register(r: Registry) {
    for (const p of presets) r.importers.set(p.id, p);
  },
};
