## Composed mail validated and stored Cc/Bcc, then never sent them [high]

**Symptom** - a staff member composes a mail in Mail Center with Cc or Bcc
recipients. The thread renders them as recipients, but they never receive the
mail. No error anywhere: the send succeeds for To.

**Root cause (traced, not guessed)** - POST /compose collects and validates
ccList/bccList (mail-center.ts) and stores ccAddresses on the message row, but
the sendEmail call passed only to/subject/html/text/purpose/from/replyTo/
companyCode/attachments - no cc, no bcc. The reply path passes both, so only
compose was affected. Found by the 2026-08-12 module-guide code-read sweep
(the guide claimed "a single Resend call carrying arrays" for all sends);
verified by reading the call site, then fixed.

**Fix** - compose's sendEmail now passes cc/bcc in the reply path's exact shape.
Verified: backend typecheck clean. Still open (own task): attachment-bearing
sends do not set outboxRetry:false, so a failed attachment send is re-drained
body-only by the */5 cron.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-12

---
