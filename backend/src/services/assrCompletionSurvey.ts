import type { Env } from "../types";
import { issueSurveyToken } from "./assr";
import { sendEmail, publicUrl } from "./email";
import { resolveCompanyCode, getBrandingForCompany } from "./branding";

/* The satisfaction survey a case sends when it reaches 'completed' — shared by
   the manual stage change (POST /api/assr/:id/transition) and the crew's
   delivery POD closing the case (scm/routes/delivery-job-progress.ts). */
export async function sendCompletionSurvey(env: Env, id: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT assr_no, customer_name, customer_email, email_for_survey, company_id
       FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{
      assr_no: string;
      customer_name: string | null;
      customer_email: string | null;
      email_for_survey: string | null;
      company_id: number | null;
    }>();
  const surveyTo = row?.email_for_survey || row?.customer_email;
  if (surveyTo) {
    // Customer-facing: carry the DOCUMENT's company identity (the case
    // row's company_id), not the operator's active company.
    const caseCompanyCode = await resolveCompanyCode(env, row!.company_id);
    const token = await issueSurveyToken(env, id);
    const link = publicUrl(env, `/survey/${token}`, caseCompanyCode);
    const name = (row!.customer_name || "").split(" ")[0] || "there";
    // Footer must carry the CASE's company (2990 cases must not sign off as
    // Houzs) — derive it from the document's branding, not a hardcode.
    const caseBranding = await getBrandingForCompany(env, caseCompanyCode);
    await sendEmail(env, {
      to: surveyTo,
      subject: `How was your experience with case ${row!.assr_no}?`,
      html: surveyEmailHtml(name, row!.assr_no, link, caseBranding.companyName),
      purpose: "assr_survey",
      refType: "assr",
      refId: id,
      companyCode: caseCompanyCode,
    });
  }
}

function surveyEmailHtml(name: string, assrNo: string, link: string, companyName: string): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Thanks for your patience, ${name}.</h2>
      <p>We've wrapped up your service case <strong>${assrNo}</strong>. Your feedback helps us improve.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Rate your experience
        </a>
      </p>
      <p style="color:#777;font-size:13px">Takes about 30 seconds — one rating + an optional note.</p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px;margin-top:28px">
        ${companyName}
      </p>
    </div>`;
}
