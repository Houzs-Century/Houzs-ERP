// ----------------------------------------------------------------------------
// accounting-numbering — the owner's own levers over voucher numbers (GL
// redesign item 8a). His rules, verbatim: PV number 到时我能自己维护,因为未来
// 可能有新的银行 — a new bank is ONE LETTER typed here, never a deploy; and
// 如果到时我要 2990-MPV-2609-0001 呢 — the suffix width is his to set.
//
// The letter table is shared vocabulary: the PV series (item 8b), the OR
// channel series (item 9) and the transfer print (item 10) all read the SAME
// letter for the same bank, so Maybank is M everywhere or nowhere. A money
// account with NO letter refuses to mint, loudly, with this screen named —
// the same never-silently rule every gap in this redesign follows.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to manage voucher numbering." };

type LetterRow = { account_code: string; letter: string };

/* ── GET /accounting/numbering — digits + per-money-account letters ───────── */
export const numberingGet = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const [accsRes, lettersRes, digitsRes] = await Promise.all([
    sb.from('accounts')
      .select('account_code, account_name, is_active')
      .eq('company_id', co.companyId)
      .eq('acc_money', true)
      .order('account_code'),
    sb.from('acc_bank_letters').select('account_code, letter').eq('company_id', co.companyId),
    sb.from('acc_numbering').select('doc_digits').eq('company_id', co.companyId).maybeSingle(),
  ]);
  if (accsRes.error) return c.json({ error: 'load_failed', reason: accsRes.error.message }, 500);
  if (lettersRes.error) return c.json({ error: 'load_failed', reason: lettersRes.error.message }, 500);
  if (digitsRes.error) return c.json({ error: 'load_failed', reason: digitsRes.error.message }, 500);

  const letterOf = new Map(((lettersRes.data ?? []) as LetterRow[]).map((r) => [r.account_code, r.letter]));
  return c.json({
    digits: Number((digitsRes.data as { doc_digits?: number } | null)?.doc_digits ?? 3),
    accounts: ((accsRes.data ?? []) as Array<{ account_code: string; account_name: string; is_active: boolean }>)
      .filter((a) => a.is_active)
      .map((a) => ({ accountCode: a.account_code, accountName: a.account_name, letter: letterOf.get(a.account_code) ?? null })),
  });
};

/* ── PUT /accounting/numbering — {digits?, letters?: [{accountCode, letter}]} ─ */
export const numberingPut = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const user = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

  if (body.digits !== undefined) {
    const digits = Number(body.digits);
    if (!Number.isInteger(digits) || digits < 3 || digits > 5) {
      return c.json({ error: 'bad_digits', message: 'Digits must be 3, 4 or 5.' }, 400);
    }
    const { error } = await sb.from('acc_numbering').upsert({
      company_id: co.companyId, doc_digits: digits, updated_at: new Date().toISOString(), updated_by: user,
    }, { onConflict: 'company_id' });
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }

  if (Array.isArray(body.letters)) {
    const seen = new Set<string>();
    const rows: Array<{ accountCode: string; letter: string }> = [];
    for (const raw of body.letters as Array<{ accountCode?: unknown; letter?: unknown }>) {
      const accountCode = String(raw.accountCode ?? '').trim();
      const letter = String(raw.letter ?? '').trim().toUpperCase();
      if (!accountCode) return c.json({ error: 'bad_letter', message: 'Every letter row needs its account.' }, 400);
      if (!/^[A-Z]{1,3}$/.test(letter)) {
        return c.json({ error: 'bad_letter', message: `${accountCode}: the letter must be 1-3 letters (A-Z).` }, 400);
      }
      /* Two banks on one letter would SHARE a number series — refuse before
         the database does, with the two named. */
      if (seen.has(letter)) return c.json({ error: 'letter_taken', message: `Letter ${letter} is used twice in this save.` }, 400);
      seen.add(letter);
      rows.push({ accountCode, letter });
    }
    /* Verified against the company's own money accounts. */
    const { data: accs, error: aErr } = await sb.from('accounts')
      .select('account_code')
      .eq('company_id', co.companyId)
      .eq('acc_money', true)
      .in('account_code', rows.map((r) => r.accountCode));
    if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
    const known = new Set(((accs ?? []) as Array<{ account_code: string }>).map((a) => a.account_code));
    const unknown = rows.find((r) => !known.has(r.accountCode));
    if (unknown) return c.json({ error: 'bad_account', message: `${unknown.accountCode} is not a money account in this company's chart.` }, 400);

    for (const r of rows) {
      const { error } = await sb.from('acc_bank_letters').upsert({
        company_id: co.companyId, account_code: r.accountCode, letter: r.letter,
        updated_at: new Date().toISOString(), updated_by: user,
      }, { onConflict: 'company_id,account_code' });
      if (error) {
        const taken = String(error.code ?? '') === '23505' || /duplicate key/i.test(String(error.message ?? ''));
        return c.json({
          error: taken ? 'letter_taken' : 'save_failed',
          message: taken ? `${r.letter} already belongs to another account — two banks cannot share a series.` : error.message,
        }, taken ? 409 : 500);
      }
    }
  }

  return c.json({ ok: true });
};
