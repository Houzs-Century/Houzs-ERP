import type { FormSchema } from "./MobileModuleForm";

/**
 * The phone's New Member form for THIS caller.
 *
 * A department-scoped Sales Director (the Sales Director position without
 * users.manage) never chooses the new member's role: every scoped invite is
 * stored with the baseline role whatever it carries (routes/users.ts,
 * docs/bugs/0887), and the desktop invite for the same caller has no Role
 * picker. A picker here would be a choice the save ignores, so the field is
 * ABSENT. Everyone else keeps the form as it is.
 */
export function memberInviteFormFor(form: FormSchema, scopedSalesDirector: boolean): FormSchema {
  if (!scopedSalesDirector) return form;
  return { ...form, fields: form.fields.filter((f) => f.key !== "role_id") };
}
