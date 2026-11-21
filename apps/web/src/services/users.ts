import type { Q, Db } from '../db/index.ts';
import { hashPassword } from '../security/password.ts';
import { newWrappedDataKey, forgetDataKey } from '../security/keys.ts';
import { sha256, randomToken } from '../security/session.ts';
import { audit } from '../security/audit.ts';
import { sendMail } from './mail.ts';
import { config } from '../config.ts';
import { translator, type Lang } from '../i18n/index.ts';

type Cat = { name: [string, string]; essential?: boolean; children?: Cat[] };

/** Default two-level Thai/English categories (FR-TXN-03). */
const DEFAULT_EXPENSE: Cat[] = [
  { name: ['อาหาร', 'Food'], essential: true, children: [{ name: ['อาหารประจำวัน', 'Daily meals'], essential: true }, { name: ['ของใช้/ซูเปอร์มาร์เก็ต', 'Groceries'], essential: true }, { name: ['ร้านอาหาร/คาเฟ่', 'Restaurants & cafés'] }] },
  { name: ['ที่อยู่อาศัย', 'Housing'], essential: true, children: [{ name: ['ค่าเช่า/ผ่อนบ้าน', 'Rent / mortgage'], essential: true }, { name: ['ค่าน้ำ', 'Water'], essential: true }, { name: ['ค่าไฟ', 'Electricity'], essential: true }, { name: ['อินเทอร์เน็ต/โทรศัพท์', 'Internet & phone'], essential: true }] },
  { name: ['เดินทาง', 'Transport'], essential: true, children: [{ name: ['น้ำมัน', 'Fuel'], essential: true }, { name: ['ขนส่งสาธารณะ', 'Public transport'], essential: true }, { name: ['ซ่อมบำรุงรถ', 'Car maintenance'] }] },
  { name: ['สุขภาพ', 'Health'], essential: true, children: [{ name: ['ยา/โรงพยาบาล', 'Medical'], essential: true }, { name: ['ประกันสุขภาพ', 'Health insurance'], essential: true }] },
  { name: ['ครอบครัว', 'Family'], children: [{ name: ['ค่าเทอมลูก', 'School fees'], essential: true }, { name: ['ให้พ่อแม่', 'Support parents'], essential: true }, { name: ['ของใช้เด็ก', 'Kids'] }] },
  { name: ['ไลฟ์สไตล์', 'Lifestyle'], children: [{ name: ['ช้อปปิ้ง', 'Shopping'] }, { name: ['บันเทิง', 'Entertainment'] }, { name: ['Subscription', 'Subscriptions'] }, { name: ['ท่องเที่ยว', 'Travel'] }] },
  { name: ['การเงิน', 'Financial'], children: [{ name: ['ดอกเบี้ย/ค่าธรรมเนียม', 'Interest & fees'], essential: true }, { name: ['ประกันชีวิต', 'Life insurance'], essential: true }, { name: ['ภาษี', 'Tax'], essential: true }] },
  { name: ['ทำบุญ/บริจาค', 'Giving'] },
  { name: ['อื่น ๆ', 'Other'] },
];
const DEFAULT_INCOME: Cat[] = [
  { name: ['เงินเดือน', 'Salary'] }, { name: ['โบนัส', 'Bonus'] }, { name: ['รายได้เสริม', 'Side income'] }, { name: ['ดอกเบี้ย/ปันผล', 'Interest & dividends'] }, { name: ['รายรับอื่น ๆ', 'Other income'] },
];

export async function seedCategories(q: Q, userId: string, lang: Lang) {
  const idx = lang === 'th' ? 0 : 1;
  let sort = 0;
  const insert = async (c: Cat, kind: string, parent: string | null) => {
    const r = await q.one<{ id: string }>('insert into categories(owner_id, parent_id, name, kind, essential, sort) values ($1,$2,$3,$4,$5,$6) returning id', [userId, parent, c.name[idx], kind, !!c.essential, sort++]);
    for (const ch of c.children ?? []) await insert(ch, kind, r!.id);
  };
  for (const c of DEFAULT_EXPENSE) await insert(c, 'expense', null);
  for (const c of DEFAULT_INCOME) await insert(c, 'income', null);
}

export async function createUser(db: Db, a: { email: string; password: string; name: string; lang: Lang; ip: string }): Promise<string> {
  const hash = await hashPassword(a.password);
  const id = await db.system(async (q) => {
    const first = !(await q.one('select 1 from users limit 1'));
    const u = await q.one<{ id: string }>('insert into users(email, password_hash, display_name, is_admin) values ($1,$2,$3,$4) returning id', [a.email.trim(), hash, a.name, first]);
    const dk = newWrappedDataKey(u!.id);
    await q.query('update users set data_key_enc = $1, data_key_version = $2 where id = $3', [dk.enc, dk.version, u!.id]);
    await audit(q, 'register', u!.id, { first }, a.ip);
    return u!.id;
  });
  await db.asUser(id, async (q) => {
    await q.query('insert into user_preferences(user_id, locale, date_era) values ($1,$2,$3)', [id, a.lang, a.lang === 'th' ? 'be' : 'ce']);
    await seedCategories(q, id, a.lang);
  });
  await sendVerification(db, id, a.email, a.lang);
  return id;
}

export async function sendVerification(db: Db, userId: string, email: string, lang: Lang) {
  const token = randomToken();
  await db.system((q) => q.query(`insert into email_tokens(token_hash, user_id, purpose, expires_at) values ($1,$2,'verify', now() + interval '2 days')`, [sha256(token), userId]));
  const t = translator(lang);
  await sendMail(email, t('mail.verify_subject'), t('mail.verify_body', { link: `${config.baseUrl}/verify?token=${token}` }));
}

export async function sendReset(db: Db, email: string, lang: Lang) {
  const u = await db.system((q) => q.one<{ id: string }>('select id from users where lower(email) = lower($1) and not disabled', [email.trim()]));
  if (!u) return; // do not reveal whether the e-mail exists (NFR-SEC-07)
  const token = randomToken();
  await db.system((q) => q.query(`insert into email_tokens(token_hash, user_id, purpose, expires_at) values ($1,$2,'reset', now() + interval '1 hour')`, [sha256(token), u.id]));
  const t = translator(lang);
  await sendMail(email, t('mail.reset_subject'), t('mail.reset_body', { link: `${config.baseUrl}/reset?token=${token}` }));
}

/** Security notification to the user by e-mail + in-app (NFR-SEC-08). */
export async function securityAlert(db: Db, userId: string, kind: string, lang: Lang, vars: Record<string, string> = {}) {
  const t = translator(lang);
  const u = await db.system((q) => q.one<{ email: string }>('select email from users where id = $1', [userId]));
  if (!u) return;
  await sendMail(u.email, t(`mail.${kind}_subject`), t(`mail.${kind}_body`, vars));
  await db.asUser(userId, (q) => q.query('insert into notifications(owner_id, kind, title, body, link) values ($1,$2,$3,$4,$5)', [userId, 'security', t(`mail.${kind}_subject`), t(`mail.${kind}_body`, vars), '/settings/security']));
}

/**
 * Account deletion (FR-SET-06, NFR-SEC-18): hard-deletes the user and, via ON DELETE CASCADE, every row they own,
 * in one transaction. Only the append-only audit_log keeps the event (user id, action, IP — no financial data).
 * Shared households the user created but no longer own are handed to a remaining member first, so the cascade
 * does not take other people's household with it. The scheduler still purges legacy soft-deleted accounts.
 */
export async function requestDeletion(db: Db, userId: string, ip: string) {
  await db.system(async (q) => {
    await audit(q, 'account_delete_requested', userId, {}, ip);
    await q.query(
      `update households h set created_by = (
         select m.user_id from members m
         where m.household_id = h.id and m.user_id is not null and m.user_id <> $1
         order by (m.role = 'owner') desc, m.created_at limit 1)
       where h.created_by = $1
         and exists (select 1 from members m where m.household_id = h.id and m.user_id is not null and m.user_id <> $1)`,
      [userId],
    );
    await q.query('delete from users where id = $1', [userId]);
  });
  forgetDataKey(userId);
}
