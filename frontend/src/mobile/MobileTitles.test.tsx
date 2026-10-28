/* Mobile Titles — the phone editor of the Roles & Permissions › Titles tab.
 * The list shows one card per ACTIVE Title; opening one and changing a control
 * saves a body the API accepts for that cohort (the SAME normalise the desktop
 * uses, from lib/titlePolicyModel); Reset removes the stored row; a viewer
 * without roles.manage sees the values with every control locked. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TitlePolicyPayload } from "../lib/titlePolicyModel";

const put = vi.fn(async () => ({ ok: true }));
const del = vi.fn(async () => ({ ok: true }));
vi.mock("../api/client", () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(), patch: vi.fn(), put: (...a: unknown[]) => put(...(a as [])), del: (...a: unknown[]) => del(...(a as [])) },
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

let canManage = true;
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ can: (p: string) => (p === "roles.manage" ? canManage : true) }) }));

// The component fetches the payload through useQuery; feed it directly so the
// test drives the editor, not TanStack's async machinery.
let queryData: TitlePolicyPayload | null = null;
const reload = vi.fn();
vi.mock("../hooks/useQuery", () => ({
  useQuery: () => ({ data: queryData, loading: false, fetching: false, placeholder: false, error: null, reload }),
}));

import { MobileTitles } from "./MobileTitles";

function payload(): TitlePolicyPayload {
  return {
    cohorts: ["god", "full", "restricted", "sales"],
    restricted_profiles: ["driver_helper", "storekeeper", "storekeeper_supervisor", "calendar_viewer"],
    sales_profiles: ["director", "rep"],
    duties: ["management", "finance", "purchasing", "logistic", "driver", "helper", "warehouse", "other"],
    positions: [
      {
        id: 3, name: "Finance Manager", slug: "finance_manager", department_name: "Finance Department", active: true,
        row: { position_id: 3, cohort: "full", profile: null, can_move_money: true, can_write_config: false, is_fleet: false, duty: "finance" },
        source: "row",
        effective: { cohort: "full", profile: null, can_move_money: true, can_write_config: false, is_fleet: false, duty: "finance" },
      },
      {
        id: 26, name: "PG WH Assistant", slug: "pg_wh_assistant", department_name: "Operation Department", active: true,
        row: null, source: "name",
        effective: { cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false },
      },
      {
        id: 99, name: "Retired Title", slug: "retired", department_name: null, active: false,
        row: null, source: "name",
        effective: { cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  put.mockClear();
  del.mockClear();
  reload.mockClear();
  canManage = true;
  queryData = null;
});

function open(name: string) {
  fireEvent.click(screen.getByText(name));
}

describe("MobileTitles", () => {
  test("lists ACTIVE Titles only, with cohort and Set/Default", () => {
    queryData = payload();
    render(<MobileTitles onBack={() => {}} />);
    expect(screen.getByText("Finance Manager")).toBeTruthy();
    expect(screen.getByText("PG WH Assistant")).toBeTruthy();
    expect(screen.queryByText("Retired Title")).toBeNull();
    expect(screen.getByText("Set")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
  });

  test("opening a Title and moving it to restricted saves the first profile, flags off", async () => {
    queryData = payload();
    render(<MobileTitles onBack={() => {}} />);
    open("PG WH Assistant");
    fireEvent.change(screen.getByLabelText("PG WH Assistant cohort"), { target: { value: "restricted" } });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/api/position-policy/26", {
      cohort: "restricted", profile: "driver_helper", can_move_money: false, can_write_config: false, is_fleet: false, duty: "other",
    });
    expect(reload).toHaveBeenCalled();
  });

  test("a full Title's money flag toggles off and saves; the duty select saves its choice", async () => {
    queryData = payload();
    render(<MobileTitles onBack={() => {}} />);
    open("Finance Manager");
    fireEvent.click(screen.getByLabelText("Finance Manager may move money"));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenLastCalledWith("/api/position-policy/3", {
      cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false, duty: "finance",
    });
    fireEvent.change(screen.getByLabelText("Finance Manager duty"), { target: { value: "management" } });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put).toHaveBeenLastCalledWith("/api/position-policy/3", {
      cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false, duty: "management",
    });
  });

  test("Reset removes the stored row for a Set Title", async () => {
    queryData = payload();
    render(<MobileTitles onBack={() => {}} />);
    open("Finance Manager");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/position-policy/3"));
  });

  test("a viewer without roles.manage gets locked controls and no Reset", () => {
    canManage = false;
    queryData = payload();
    render(<MobileTitles onBack={() => {}} />);
    open("Finance Manager");
    expect((screen.getByLabelText("Finance Manager cohort") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });
});
