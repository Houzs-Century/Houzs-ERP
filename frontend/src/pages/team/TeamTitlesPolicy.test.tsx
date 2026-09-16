/* Roles & Permissions › Titles (part B): the editor renders one row per active
 * Title from the API payload, a cohort change saves a body the API accepts for
 * that cohort (profile only where the cohort takes one, flags only where it
 * owns them), and Reset removes the stored row. The vocabularies come from the
 * payload — nothing here restates a backend list. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const put = vi.fn(async () => ({ ok: true }));
const del = vi.fn(async () => ({ ok: true }));
vi.mock("../../api/client", () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(), patch: vi.fn(), put: (...a: unknown[]) => put(...(a as [])), del: (...a: unknown[]) => del(...(a as [])), putBinary: vi.fn() },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { TeamTitlesPolicy, type TitlePolicyPayload } from "./TeamTitlesPolicy";

function payload(): TitlePolicyPayload {
  return {
    cohorts: ["god", "full", "restricted", "sales"],
    restricted_profiles: ["driver_helper", "storekeeper", "storekeeper_supervisor", "calendar_viewer"],
    sales_profiles: ["director", "rep"],
    positions: [
      {
        id: 3, name: "Finance Manager", slug: "finance_manager", department_name: "Finance Department", active: true,
        row: { position_id: 3, cohort: "full", profile: null, can_move_money: true, can_write_config: false, is_fleet: false },
        source: "row",
        effective: { cohort: "full", profile: null, can_move_money: true, can_write_config: false, is_fleet: false },
      },
      {
        id: 26, name: "PG WH Assistant", slug: "pg_wh_assistant", department_name: "Operation Department", active: true,
        row: null,
        source: "name",
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
});

describe("TeamTitlesPolicy", () => {
  test("renders one row per ACTIVE Title with its cohort, source and flags", () => {
    render(<TeamTitlesPolicy payload={payload()} canEdit onSaved={() => {}} />);
    expect(screen.getByText("Finance Manager")).toBeTruthy();
    expect(screen.getByText("PG WH Assistant")).toBeTruthy();
    expect(screen.queryByText("Retired Title")).toBeNull();
    expect((screen.getByLabelText("Finance Manager cohort") as HTMLSelectElement).value).toBe("full");
    expect(screen.getByLabelText("Finance Manager may move money").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("Set")).toHaveLength(1);
    expect(screen.getAllByText("Default")).toHaveLength(1);
  });

  test("moving a Title to restricted saves the first profile and drops the money/config flags", async () => {
    const onSaved = vi.fn();
    render(<TeamTitlesPolicy payload={payload()} canEdit onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("PG WH Assistant cohort"), { target: { value: "restricted" } });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/api/position-policy/26", {
      cohort: "restricted", profile: "driver_helper", can_move_money: false, can_write_config: false, is_fleet: false,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  test("a full Title's money flag toggles and saves; sales takes rep by default", async () => {
    render(<TeamTitlesPolicy payload={payload()} canEdit onSaved={() => {}} />);
    fireEvent.click(screen.getByLabelText("Finance Manager may move money"));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenLastCalledWith("/api/position-policy/3", {
      cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false,
    });
    fireEvent.change(screen.getByLabelText("Finance Manager cohort"), { target: { value: "sales" } });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put).toHaveBeenLastCalledWith("/api/position-policy/3", {
      cohort: "sales", profile: "rep", can_move_money: false, can_write_config: false, is_fleet: false,
    });
  });

  test("Reset removes the stored row; a reader without roles.manage gets no controls", async () => {
    const { unmount } = render(<TeamTitlesPolicy payload={payload()} canEdit onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/position-policy/3"));
    unmount();
    render(<TeamTitlesPolicy payload={payload()} canEdit={false} onSaved={() => {}} />);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect((screen.getByLabelText("Finance Manager cohort") as HTMLSelectElement).disabled).toBe(true);
  });
});
