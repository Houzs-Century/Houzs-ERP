// Both Change Log surfaces — the desktop page and its phone twin — against a
// mocked API.
//
// What is asserted is the OWNER's requirement, not the markup:
//
//   1. A system change is NEVER counted as a staff change. This is the whole
//      product: a check written the day before reported "50 staff actions on
//      migrated orders" and all fifty were the stock-allocation cron. The page
//      opens on People, says the system's count separately, and the machine
//      rows are one chip away.
//   2. Who changed WHICH document, and from what to what, is readable — the
//      from -> to pair is on screen once a row is opened.
//   3. A load failure is said out loud rather than rendered as an empty table.
//   4. A truncated read says its numbers are floors.
//   5. Times are Malaysia local.
//   6. The two surfaces answer identically. They share lib/changeLog.ts, and the
//      recurring bug class here is a rule fixed on one surface and not the
//      other, so both are mounted from the SAME fixtures in this file.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { ChangeLog } from "./ChangeLog";
import { MobileChangeLog } from "../mobile/MobileChangeLog";
import type { ChangeLogDocument, ChangeLogResponse } from "../lib/changeLog";

afterEach(cleanup);
/* Braces, not a concise arrow: a mock returned from beforeEach is called as the
   test's teardown, which once made a rejection armed in one test surface in
   another (autoCountSync.test.tsx has the trace). */
beforeEach(() => { apiGet.mockReset(); });

const HER_EDIT: ChangeLogDocument = {
  docType: "SO",
  docNo: "HC-SO-013361",
  entityId: null,
  lastChangeAt: "2026-09-08T06:00:00.000Z",
  changeCount: 1,
  people: ["Wei Siang"],
  changes: [{
    id: "c1",
    at: "2026-09-08T06:00:00.000Z",
    author: "person",
    who: "Wei Siang",
    action: "UPDATE_DETAILS",
    source: "web",
    status: null,
    fields: [{ field: "delivery_address", from: "12 Jalan Lama", to: "88 Jalan Baru, Klang" }],
  }],
};

const THE_CRON: ChangeLogDocument = {
  docType: "SO",
  docNo: "HC-SO-012929",
  entityId: null,
  lastChangeAt: "2026-09-08T05:00:00.000Z",
  changeCount: 1,
  people: [],
  changes: [{
    id: "c2",
    at: "2026-09-08T05:00:00.000Z",
    author: "machine",
    who: "system (auto-allocate)",
    action: "UPDATE_LINE",
    source: "auto-allocation",
    status: null,
    fields: [{ field: "stockStatus", from: "auto", to: "2 line(s) -> READY" }],
  }],
};

function payload(over: Partial<ChangeLogResponse> = {}): ChangeLogResponse {
  return {
    window: { since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T08:00:00.000Z", hours: 168 },
    filters: { author: "person", docTypes: ["SO", "PO", "DO", "GRN"] },
    totals: {
      changesByPerson: 1,
      changesBySystem: 550,
      documents: 1,
      documentsShown: 1,
      people: 1,
      truncated: false,
    },
    documents: [HER_EDIT],
    ...over,
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function mountDesktop(body: ChangeLogResponse | Error, path = "/change-log") {
  if (body instanceof Error) apiGet.mockRejectedValue(body);
  else apiGet.mockResolvedValue(body);
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[path]}>
        <ChangeLog />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByText("Change Log");
}

async function mountMobile(body: ChangeLogResponse | Error) {
  if (body instanceof Error) apiGet.mockRejectedValue(body);
  else apiGet.mockResolvedValue(body);
  render(
    <QueryClientProvider client={client()}>
      <MobileChangeLog onBack={() => {}} />
    </QueryClientProvider>,
  );
  return screen.findByText("Change Log");
}

describe("the desktop page", () => {
  it("opens on PEOPLE and asks the server for the person rows", async () => {
    await mountDesktop(payload());
    await screen.findByText("HC-SO-013361");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/change-log?hours=168&author=person");
  });

  it("never counts the system's changes as staff changes, and still shows the number", async () => {
    await mountDesktop(payload());
    const verdict = await screen.findByText(/1 change\(s\) by 1 person\/people/);
    expect(verdict.textContent).toContain("The system itself made another 550");
  });

  it("says plainly when nobody changed anything, instead of showing 550 as activity", async () => {
    await mountDesktop(payload({
      totals: { changesByPerson: 0, changesBySystem: 550, documents: 0, documentsShown: 0, people: 0, truncated: false },
      documents: [],
    }));
    const verdict = await screen.findByText(/Nobody changed anything/);
    expect(verdict.textContent).toContain("550");
    expect(verdict.textContent).toContain("not staff edits");
  });

  it("names who changed which document, and shows the from -> to once the row is opened", async () => {
    await mountDesktop(payload());
    await screen.findByText("HC-SO-013361");
    expect(screen.getByText("Wei Siang")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByText("12 Jalan Lama")).toBeTruthy();
    expect(screen.getByText("88 Jalan Baru, Klang")).toBeTruthy();
    expect(screen.getByText("Delivery address:")).toBeTruthy();
  });

  it("switching to the system chip asks the server for machine rows, not for a local re-filter", async () => {
    await mountDesktop(payload());
    await screen.findByText("HC-SO-013361");
    apiGet.mockResolvedValue(payload({
      filters: { author: "machine", docTypes: ["SO", "PO", "DO", "GRN"] },
      documents: [THE_CRON],
    }));
    await userEvent.click(screen.getByRole("button", { name: "The system" }));
    expect(apiGet).toHaveBeenLastCalledWith("/api/scm/change-log?hours=168&author=machine");
    /* The machine row is credited to the machine by NAME, so nobody reads it as
       a colleague's edit. */
    expect(await screen.findByText("The system only")).toBeTruthy();
  });

  it("prints Malaysia local time, not UTC", async () => {
    await mountDesktop(payload());
    expect(await screen.findByText(/08\/09\/2026 14:00/)).toBeTruthy();
  });

  it("says a load failure out loud rather than rendering an empty table", async () => {
    await mountDesktop(new Error("the change log is unreachable"));
    expect(await screen.findByText(/could not be read, so nothing below is complete/)).toBeTruthy();
    expect(screen.getByText(/the change log is unreachable/)).toBeTruthy();
  });

  it("says the counts are floors when the read hit its ceiling", async () => {
    await mountDesktop(payload({
      totals: { changesByPerson: 1, changesBySystem: 550, documents: 1, documentsShown: 1, people: 1, truncated: true },
    }));
    expect(await screen.findByText(/floor, not a total/)).toBeTruthy();
  });

  it("reads the filters out of the URL, so a filtered view is a link", async () => {
    await mountDesktop(payload(), "/change-log?hours=24&author=all&docType=DO");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/change-log?hours=24&author=all&docType=DO");
  });
});

describe("the phone twin answers identically", () => {
  it("shows the same verdict sentence, with both numbers", async () => {
    await mountMobile(payload());
    const verdict = await screen.findByText(/1 change\(s\) by 1 person\/people/);
    expect(verdict.textContent).toContain("The system itself made another 550");
  });

  it("names who changed which document and opens the from -> to", async () => {
    await mountMobile(payload());
    await screen.findByText("HC-SO-013361");
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByText("12 Jalan Lama")).toBeTruthy();
    expect(screen.getByText("88 Jalan Baru, Klang")).toBeTruthy();
  });

  it("says a load failure out loud too", async () => {
    await mountMobile(new Error("the change log is unreachable"));
    expect(await screen.findByText(/could not be read, so nothing below is complete/)).toBeTruthy();
  });

  it("opens on the same window and the same author as the desktop page", async () => {
    await mountMobile(payload());
    await screen.findByText("HC-SO-013361");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/change-log?hours=168&author=person");
  });
});
