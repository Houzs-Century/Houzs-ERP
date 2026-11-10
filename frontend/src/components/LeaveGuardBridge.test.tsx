import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate } from "react-router-dom";
import { DialogProvider } from "../hooks/useDialog";
import { useFormTouched, useLeaveGuard } from "../hooks/useLeaveGuard";
import { FormTouchScope } from "./FormTouchScope";
import { LeaveGuardBridge } from "./LeaveGuardBridge";
import { allowNextUnload, leaveGuardActive, resetLeaveGuardForTests } from "../lib/leaveGuard";
import { hasUnsavedWork } from "../lib/unsavedWork";

function NewOrderForm() {
  const navigate = useNavigate();
  const { touched, markTouched } = useFormTouched();
  const { allowLeave } = useLeaveGuard(touched, null);
  const [name, setName] = useState("");
  return (
    <FormTouchScope onTouch={markTouched}>
      <h1>New order</h1>
      <input aria-label="Customer" value={name} onChange={(e) => setName(e.target.value)} />
      <ul role="listbox">
        <li role="option" aria-selected={false}>Sofa</li>
      </ul>
      <button
        type="button"
        onClick={() => {
          allowLeave();
          navigate("/orders/1");
        }}
      >
        Save
      </button>
      <button type="button" onClick={() => navigate("/orders/new?step=2")}>
        Next step
      </button>
      <Link to="/orders">Orders list</Link>
    </FormTouchScope>
  );
}

function renderApp(start = "/orders/new") {
  window.history.replaceState(null, "", "/orders");
  window.history.pushState(null, "", start);
  return render(
    <BrowserRouter>
      <DialogProvider>
        <Routes>
          <Route path="/orders" element={<><h1>Orders list page</h1><Link to="/orders/new">New</Link></>} />
          <Route path="/orders/new" element={<NewOrderForm />} />
          <Route path="/orders/:id" element={<h1>Saved order page</h1>} />
        </Routes>
        <LeaveGuardBridge />
      </DialogProvider>
    </BrowserRouter>,
  );
}

const dialogTitle = () => screen.queryByText("Leave without saving?");

beforeEach(() => resetLeaveGuardForTests());
afterEach(() => {
  cleanup();
  resetLeaveGuardForTests();
});

describe("leaving a form with unsaved typing", () => {
  it("an untouched form leaves without asking", () => {
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "Orders list" }));
    expect(screen.getByText("Orders list page")).toBeTruthy();
    expect(dialogTitle()).toBeNull();
  });

  it("typing arms the guard; a link asks, and Stay keeps the form and the typing", async () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    expect(leaveGuardActive()).toBe(true);
    expect(hasUnsavedWork({ pathname: "/x", search: "" })).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Orders list" }));
    await waitFor(() => expect(dialogTitle()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(dialogTitle()).toBeNull());
    expect(screen.getByText("New order")).toBeTruthy();
    expect((screen.getByLabelText("Customer") as HTMLInputElement).value).toBe("Tan");
  });

  it("Leave and discard goes where the person clicked, asked once", async () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    fireEvent.click(screen.getByRole("link", { name: "Orders list" }));
    await waitFor(() => expect(dialogTitle()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Leave and discard" }));
    await waitFor(() => expect(screen.getByText("Orders list page")).toBeTruthy());
    expect(dialogTitle()).toBeNull();
    expect(leaveGuardActive()).toBe(false);
  });

  it("picking an option from a list counts as touching the form", () => {
    renderApp();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Sofa" }));
    expect(leaveGuardActive()).toBe(true);
  });

  it("a successful save goes to the saved document with no prompt", () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saved order page")).toBeTruthy();
    expect(dialogTitle()).toBeNull();
  });

  it("a query-string move on the same page is not leaving", () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(window.location.search).toBe("?step=2");
    expect(dialogTitle()).toBeNull();
  });

  it("the browser's Back asks first and stays on the form when refused", async () => {
    renderApp("/orders");
    fireEvent.click(screen.getByRole("link", { name: "New" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(dialogTitle()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(window.location.pathname).toBe("/orders/new"));
    // Still "Tan": the router never saw the move, so the form never unmounted.
    expect((screen.getByLabelText("Customer") as HTMLInputElement).value).toBe("Tan");
  });

  it("the browser's Back goes back once the person chooses to leave", async () => {
    renderApp("/orders");
    fireEvent.click(screen.getByRole("link", { name: "New" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(dialogTitle()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Leave and discard" }));
    await waitFor(() => expect(screen.getByText("Orders list page")).toBeTruthy());
    expect(window.location.pathname).toBe("/orders");
  });

  it("closing the tab or reloading asks while dirty, and not after allowNextUnload", () => {
    renderApp();
    const fire = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    expect(fire()).toBe(true);
    allowNextUnload();
    expect(fire()).toBe(false);
  });

  it("unmounting the form drops the guard", () => {
    const { unmount } = renderApp();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Tan" } });
    expect(leaveGuardActive()).toBe(true);
    unmount();
    expect(leaveGuardActive()).toBe(false);
  });
});
