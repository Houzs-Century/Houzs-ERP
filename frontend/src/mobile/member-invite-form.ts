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

/**
 * The member fields PATCH /api/users/:id still applies for a department-scoped
 * Sales Director. The handler deletes everything else that caller sends (role,
 * position, department, manager, companies, password, email, email alias) and
 * still answers ok, so any other field would save nothing while the phone
 * reported success
 * (docs/bugs/0924-a-sales-director-s-phone-edit-of-a-member-s-role-department.md).
 * member-invite-form.test.ts derives this list from the handler and fails when
 * the two disagree.
 */
export const SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS: readonly string[] = [
  "name",
  "phone",
  "status",
  "status_reason",
  "division",
];

/**
 * The phone's Edit Member form for THIS caller: a scoped Sales Director gets
 * only the fields their save applies, as the desktop profile offers them none
 * of the stripped ones. It keeps the listed fields rather than dropping the
 * stripped ones, so a field added to the form later stays hidden from that
 * caller until the server applies it.
 */
export function memberEditFormFor(form: FormSchema, scopedSalesDirector: boolean): FormSchema {
  if (!scopedSalesDirector) return form;
  return {
    ...form,
    fields: form.fields.filter((f) => SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS.includes(f.key)),
  };
}
