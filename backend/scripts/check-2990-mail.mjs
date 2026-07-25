// Read-only report on the 2990 Mail Center go-live (PR #1243 + mig 0193).
//
// Answers, from production, the questions the go-live checklist leaves open
// after the code ships: does the hello@2990shome.com mailbox row exist and is
// it active, is it stamped with the 2990 company, has anyone been granted
// access yet, did the IMAP sync's ingested messages land as threads tagged
// 2990, and has an outbound send from the mailbox happened yet.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — the answer IS the output. Only an unreachable database
// or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const BOX = "hello@2990shome.com";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [r] = await pg`
    SELECT
      (SELECT id FROM companies WHERE code = '2990')                       AS company_2990_id,
      (SELECT value::jsonb->>'email' FROM app_settings
        WHERE key = 'branding:2990')                                       AS branding_email,
      (SELECT json_build_object('active', active, 'company_id', company_id,
                                'label', label)
         FROM email_addresses WHERE lower(address) = lower(${BOX}))        AS mailbox,
      (SELECT count(*) FROM email_address_access aa
         JOIN email_addresses a ON a.id = aa.address_id
        WHERE lower(a.address) = lower(${BOX}))                            AS access_grants,
      (SELECT count(*) FROM email_threads
        WHERE lower(mailbox_address) = lower(${BOX}))                      AS threads,
      (SELECT count(*) FROM email_threads
        WHERE lower(mailbox_address) = lower(${BOX})
          AND company_id = (SELECT id FROM companies WHERE code = '2990')) AS threads_tagged_2990,
      (SELECT count(*) FROM email_messages m
         JOIN email_threads t ON t.id = m.thread_id
        WHERE lower(t.mailbox_address) = lower(${BOX})
          AND m.direction = 'in')                                          AS inbound_msgs,
      (SELECT count(*) FROM email_messages m
         JOIN email_threads t ON t.id = m.thread_id
        WHERE lower(t.mailbox_address) = lower(${BOX})
          AND m.direction = 'out')                                         AS outbound_msgs,
      (SELECT max(m.created_at) FROM email_messages m
         JOIN email_threads t ON t.id = m.thread_id
        WHERE lower(t.mailbox_address) = lower(${BOX}))                    AS latest_message_at,
      (SELECT json_agg(json_build_object(
                'subject', left(s.subject, 60),
                'from', s.counterparty_email,
                'at', s.last_message_at,
                'company_id', s.company_id))
         FROM (SELECT subject, counterparty_email, last_message_at, company_id
                 FROM email_threads
                WHERE lower(mailbox_address) = lower(${BOX})
                ORDER BY last_message_at DESC
                LIMIT 6) s)                                                AS recent_threads`;

  notice(`company 2990 id     : ${r.company_2990_id ?? "MISSING — companies row absent"}`);
  notice(`branding:2990 email : ${r.branding_email ?? "MISSING"}`);
  notice(
    r.mailbox
      ? `mailbox row         : active=${r.mailbox.active} company_id=${r.mailbox.company_id} label=${r.mailbox.label}`
      : "mailbox row         : MISSING — mig 0193 seed did not land",
  );
  notice(`access grants       : ${r.access_grants} (0 = nobody assigned in Mail Center -> Mailboxes yet)`);
  notice(`threads             : ${r.threads} (tagged 2990: ${r.threads_tagged_2990})`);
  notice(`messages in/out     : ${r.inbound_msgs} / ${r.outbound_msgs}`);
  notice(`latest message at   : ${r.latest_message_at ?? "none"}`);
  for (const t of r.recent_threads ?? []) {
    notice(`  thread: [co=${t.company_id}] ${t.at} <${t.from}> ${t.subject}`);
  }

  const ok =
    r.company_2990_id != null &&
    r.mailbox?.active === 1 &&
    Number(r.threads) > 0 &&
    Number(r.threads_tagged_2990) === Number(r.threads);
  notice(
    ok
      ? "VERDICT: inbound path WORKING — mailbox seeded + active, threads present, all tagged 2990."
      : "VERDICT: NOT fully working yet — see the lines above for which piece is missing.",
  );
} finally {
  await pg.end({ timeout: 5 });
}
