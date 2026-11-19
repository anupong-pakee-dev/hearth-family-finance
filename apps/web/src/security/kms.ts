/**
 * Master-key adapters (NFR-SEC-15). The master keys never live in the database; they are read at start-up from:
 *   HEARTH_KEY_PROVIDER=env    (default) HEARTH_MASTER_KEYS or HEARTH_MASTER_KEYS_FILE
 *   HEARTH_KEY_PROVIDER=vault  HashiCorp Vault KV v2: VAULT_ADDR, VAULT_TOKEN | VAULT_TOKEN_FILE, VAULT_KV_PATH (e.g. secret/data/hearth)
 *   HEARTH_KEY_PROVIDER=aws    AWS Secrets Manager: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY[, AWS_SESSION_TOKEN], HEARTH_AWS_SECRET_ID
 * The secret value has the same format as HEARTH_MASTER_KEYS ("id:base64key,old:base64key"), so rotation works the same.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setKeyProvider, keyProviderFromSpec } from './keys.ts';

async function fromVault(): Promise<string> {
  const addr = (process.env.VAULT_ADDR ?? '').replace(/\/$/, '');
  const token = process.env.VAULT_TOKEN ?? (process.env.VAULT_TOKEN_FILE ? readFileSync(process.env.VAULT_TOKEN_FILE, 'utf8').trim() : '');
  const path = process.env.VAULT_KV_PATH ?? 'secret/data/hearth';
  if (!addr || !token) throw new Error('VAULT_ADDR and VAULT_TOKEN are required');
  const res = await fetch(`${addr}/v1/${path}`, { headers: { 'X-Vault-Token': token }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`vault responded ${res.status}`);
  const json = (await res.json()) as { data?: { data?: { master_keys?: string } } };
  const spec = json.data?.data?.master_keys;
  if (!spec) throw new Error('vault secret has no "master_keys" field');
  return spec;
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const hash = (data: string) => createHash('sha256').update(data).digest('hex');

/** AWS Signature Version 4 for a JSON POST (exported for tests). */
export function signV4(o: { region: string; service: string; host: string; target: string; body: string; accessKey: string; secretKey: string; sessionToken?: string; now?: Date }): Record<string, string> & { authorization: string } {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', host: o.host, 'x-amz-date': amzDate, 'x-amz-target': o.target };
  if (o.sessionToken) headers['x-amz-security-token'] = o.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = ['POST', '/', '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), hash(o.body)].join('\n');
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), o.region), o.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function fromAws(): Promise<string> {
  const region = process.env.AWS_REGION ?? '';
  const accessKey = process.env.AWS_ACCESS_KEY_ID ?? '', secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? '';
  const secretId = process.env.HEARTH_AWS_SECRET_ID ?? '';
  if (!region || !accessKey || !secretKey || !secretId) throw new Error('AWS_REGION, AWS credentials and HEARTH_AWS_SECRET_ID are required');
  const host = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretId });
  const headers = signV4({ region, service: 'secretsmanager', host, target: 'secretsmanager.GetSecretValue', body, accessKey, secretKey, sessionToken: process.env.AWS_SESSION_TOKEN });
  const res = await fetch(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`secrets manager responded ${res.status}`);
  const json = (await res.json()) as { SecretString?: string };
  if (!json.SecretString) throw new Error('secret has no SecretString');
  return json.SecretString.trim();
}

/** Call once at start-up (server and CLI scripts) before anything encrypts or decrypts. */
export async function initKeys() {
  const kind = process.env.HEARTH_KEY_PROVIDER ?? 'env';
  if (kind === 'env') return; // lazy env/file provider in keys.ts
  const spec = kind === 'vault' ? await fromVault() : kind === 'aws' ? await fromAws() : (() => { throw new Error(`unknown HEARTH_KEY_PROVIDER ${kind}`); })();
  setKeyProvider(keyProviderFromSpec(spec));
}
