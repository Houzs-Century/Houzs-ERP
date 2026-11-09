import { api } from "../api/client";

/* Crew PIN sign-in — the admin side, shared by the desktop member profile
 * (pages/team/FieldPinCard.tsx) and the phone member screen
 * (mobile/MobileFieldPin.tsx). The server (routes/fieldPinAdmin.ts) decides who
 * may hold a PIN; the screens only show its answer. */

export type FieldPinStatus = {
  eligible: boolean;
  reason: "ok" | "not_crew_title" | "no_staff_code" | "staff_code_shape" | "inactive";
  login: string | null;
  hasPin: boolean;
  locked: boolean;
  lockedUntil: string | null;
  setAt: string | null;
};

export const FIELD_PIN_LENGTH = 6;

export const fetchFieldPinStatus = (userId: number) => api.get<FieldPinStatus>(`/api/field-pin/${userId}`);
export const setFieldPin = (userId: number, pin: string) => api.post<{ ok: true; login: string }>(`/api/field-pin/${userId}`, { pin });
export const clearFieldPin = (userId: number) => api.del<{ ok: true }>(`/api/field-pin/${userId}`);

/** Office staff never see the card: it appears for a crew Title, or for anyone
 *  who still holds a PIN (so a Title change away from crew can be cleaned up). */
export const showsFieldPin = (s: FieldPinStatus | null): boolean => !!s && (s.reason !== "not_crew_title" || s.hasPin);

export function fieldPinReasonText(s: FieldPinStatus): string | null {
  switch (s.reason) {
    case "ok":
      return null;
    case "not_crew_title":
      return "This member's Title is not a Driver / Helper Title, so the PIN cannot be used to sign in.";
    case "no_staff_code":
      return "This member has no staff code yet, so there is nothing to sign in with.";
    case "staff_code_shape":
      return `Their staff code (${s.login ?? "none"}) does not start with EMP-, so it cannot be typed on the crew sign-in screen.`;
    case "inactive":
      return "This member is not active.";
  }
}
