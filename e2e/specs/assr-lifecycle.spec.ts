import { test, expect, Browser, BrowserContext, Page, APIRequestContext } from "@playwright/test";
import {
  CFG,
  requireEnv,
  loginStaff,
  attachStaffAuth,
  apiFor,
  apiJson,
  tinyJpeg,
  waitForText,
} from "../lib/helpers";

// Full ASSR service-case lifecycle — staff + customer running side by
// side. Each `test.step` is one Act from the manual walkthrough so the
// HTML report shows a clear narrative.
//
// Structure: ONE test with many steps. The case lifecycle is a single
// linear story; splitting into multiple tests would either force
// fixture state-sharing (fragile) or re-create a case each time (slow).

test.describe("ASSR lifecycle — staff + customer", () => {
  test.describe.configure({ mode: "serial" });

  let browser: Browser;
  let staffCtx: BrowserContext;
  let customerCtx: BrowserContext;
  let staffPage: Page;
  let customerPage: Page;
  let api: APIRequestContext;

  // State passed between steps.
  const state: {
    staffToken?: string;
    assrId?: number;
    assrNo?: string;
    portalUrl?: string;
    portalToken?: string;
    supplierId?: number;
    customerUploadAttId?: number;
    staffUploadAttId?: number;
  } = {};

  test.beforeAll(async ({ browser: b }) => {
    requireEnv();
    browser = b;
    state.staffToken = await loginStaff();

    staffCtx = await browser.newContext();
    customerCtx = await browser.newContext();

    await attachStaffAuth(staffCtx, state.staffToken!);
    staffPage = await staffCtx.newPage();
    customerPage = await customerCtx.newPage();

    api = await apiFor(state.staffToken!);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await staffCtx?.close();
    await customerCtx?.close();
  });

  // ═══════════════════════════════════════════════════════════════
  test("lifecycle", async () => {
    // ── Act 1: supplier setup ──────────────────────────────
    await test.step("Act 1 — Ensure test supplier exists", async () => {
      const list = await apiJson<{ data: any[] }>(api, "GET", `/api/suppliers?search=${encodeURIComponent(CFG.SUPPLIER_NAME)}`);
      const existing = list.data.find((s) => s.name === CFG.SUPPLIER_NAME);
      if (existing) {
        state.supplierId = existing.id;
      } else {
        const r = await apiJson<{ id: number }>(api, "POST", "/api/suppliers", {
          name: CFG.SUPPLIER_NAME,
          category: "upholstery",
          sla_response_hours: 24,
          sla_completion_hours: 168,
        });
        state.supplierId = r.id;
      }
      expect(state.supplierId).toBeTruthy();
    });

    // ── Act 2: case creation ───────────────────────────────
    await test.step("Act 2 — Staff creates case via UI", async () => {
      await staffPage.goto("/assr");
      await staffPage.getByRole("button", { name: /New Case/i }).click();

      // SO lookup
      await staffPage.getByPlaceholder(/SO number/i).fill(CFG.SO_NO);
      await staffPage.getByRole("button", { name: /Lookup/i }).click();

      // Wait for items to load, tick the first checkbox
      const firstItemCheckbox = staffPage.locator('input[type="checkbox"]').first();
      await firstItemCheckbox.waitFor({ state: "visible", timeout: 20_000 });
      await firstItemCheckbox.check();

      // Issue description
      await staffPage
        .getByPlaceholder(/Describe the issue/i)
        .fill("[E2E TEST] Sofa cushion torn at seams — 2 cushions affected");

      // Upload 3 photos
      const buffers = ["red", "green", "blue"] as const;
      const files = buffers.map((hue, i) => ({
        name: `e2e-complaint-${i + 1}.jpg`,
        mimeType: "image/jpeg",
        buffer: tinyJpeg(hue),
      }));
      await staffPage.locator('input[type="file"][accept*="image"]').first().setInputFiles(files);

      // Create — wait for the POST to return then settle
      const [createResp] = await Promise.all([
        staffPage.waitForResponse((r) => r.url().includes("/api/assr") && r.request().method() === "POST"),
        staffPage.getByRole("button", { name: /Create Case/i }).click(),
      ]);
      expect(createResp.status()).toBe(201);
      const created = await createResp.json();
      state.assrId = created.id;
      state.assrNo = created.assr_no;
      expect(state.assrNo).toMatch(/^ASSR\/\d{4}-\d{3}$/);

      // Give the attachment uploads + panel open a chance to finish.
      await staffPage.waitForTimeout(2_500);
    });

    // ── Act 3: generate portal link + customer opens ──────
    await test.step("Act 3 — Generate portal link; customer opens it", async () => {
      // Use the API directly so we don't have to hunt for the button text
      // (UI may evolve; API is the contract).
      const r = await apiJson<{ token: string; path: string }>(
        api,
        "POST",
        `/api/assr/${state.assrId}/track-link`
      );
      state.portalToken = r.token;
      state.portalUrl = `${CFG.BASE_URL}${r.path}`;
      expect(state.portalUrl).toContain("/portal/case/");

      await customerPage.goto(state.portalUrl);
      await waitForText(customerPage, state.assrNo!);
      await waitForText(customerPage, "Pending Review");
    });

    // ── Act 4 (partial): verify data hiding ───────────────
    await test.step("Act 4 — Portal response omits internal fields", async () => {
      const detailResp = await customerPage.waitForResponse(
        (r) => r.url().includes("/portal/api/case") && r.request().method() === "GET"
      ).catch(() => null);

      // Fetch once more if we missed the initial load
      const jsonStr = detailResp
        ? await detailResp.text()
        : JSON.stringify(
            await (
              await customerPage.request.get(`${CFG.BASE_URL}/portal/api/case`, {
                headers: { Authorization: `Bearer ${state.portalToken}` },
              })
            ).json()
          );

      const mustNotLeak = [
        "supplier_id", "supplier_name", "supplier_phone", "supplier_email",
        "po_no", "po_amount", "supplier_invoice_ref", "cost_notes",
        "action_remark", "approved_by", "ncr_category",
        "assigned_to", "sla_hours", "is_breached",
        "addr3", "addr4",
      ];
      for (const key of mustNotLeak) {
        expect(jsonStr, `portal response leaked: ${key}`).not.toContain(`"${key}"`);
      }
    });

    // ── Act 5: stage advancement visible to customer ──────
    await test.step("Act 5 — Staff walks stages; customer sees status updates", async () => {
      const stages: Array<{ to: string; label: string }> = [
        { to: "triage",    label: "Under Verification" },
        { to: "action",    label: "Pending Solution" },
        { to: "logistics", label: "In Progress" },
      ];

      for (const st of stages) {
        await apiJson(api, "POST", `/api/assr/${state.assrId}/transition`, { stage: st.to });
        await customerPage.reload({ waitUntil: "networkidle" });
        await waitForText(customerPage, st.label);
      }
    });

    // ── Act 6: customer comments → staff sees it ──────────
    await test.step("Act 6 — Customer posts comment; staff sees it", async () => {
      const textarea = customerPage.getByPlaceholder(/Our team will see/i);
      await textarea.fill("[E2E TEST] When will the sofa be ready? We have guests next weekend.");
      await customerPage.getByRole("button", { name: /Post update/i }).click();
      await waitForText(customerPage, "[E2E TEST] When will the sofa be ready");

      // Staff verification via API (UI verification later)
      const detail = await apiJson<any>(api, "GET", `/api/assr/${state.assrId}`);
      const hasCustomerComment = (detail.activity || []).some(
        (a: any) => a.action === "customer_comment" && a.source === "customer" && a.note?.includes("guests next weekend")
      );
      expect(hasCustomerComment, "customer comment missing from staff detail").toBe(true);
    });

    // ── Act 7: photo exchange ─────────────────────────────
    await test.step("Act 7 — Customer uploads photo; staff uploads photo", async () => {
      // Customer upload via API (the UI has a hidden file input that's
      // harder to target cross-browser; API path tests the same code).
      const custRes = await customerPage.request.put(
        `${CFG.BASE_URL}/portal/api/case/attachments?ext=jpg&name=e2e-customer.jpg`,
        {
          headers: { Authorization: `Bearer ${state.portalToken}`, "Content-Type": "image/jpeg" },
          data: tinyJpeg("blue"),
        }
      );
      expect(custRes.status()).toBe(201);
      state.customerUploadAttId = (await custRes.json()).id;

      // Staff side: add an internal evidence photo directly via the worker API
      const staffRes = await api.put(
        `/api/assr/${state.assrId}/attachments?category=evidence&ext=jpg&name=e2e-staff.jpg`,
        {
          headers: { "Content-Type": "image/jpeg" },
          data: tinyJpeg("green"),
        }
      );
      expect(staffRes.status()).toBe(201);
      state.staffUploadAttId = (await staffRes.json()).id;

      // Confirm both render for the customer
      await customerPage.reload({ waitUntil: "networkidle" });
      const attCount = await customerPage.locator("img").count();
      // 3 complaint + 1 customer upload + 1 staff upload = 5 (plus logo header)
      expect(attCount).toBeGreaterThanOrEqual(5);
    });

    // ── Act 8: hide-from-customer toggle ──────────────────
    await test.step("Act 8 — Staff hides the internal photo; customer view updates", async () => {
      await apiJson(api, "PATCH", `/api/assr/attachments/${state.staffUploadAttId}/visibility`, {
        visible_to_customer: false,
      });

      // Direct fetch as the customer → expect 404
      const res = await customerPage.request.get(
        `${CFG.BASE_URL}/portal/api/case/attachments/${state.staffUploadAttId}`,
        { headers: { Authorization: `Bearer ${state.portalToken}` } }
      );
      expect(res.status()).toBe(404);
    });

    // ── Act 9: supplier + auto-PO + cost ──────────────────
    await test.step("Act 9 — Staff assigns supplier, generates PO, adds cost", async () => {
      // Link supplier
      await apiJson(api, "PATCH", `/api/assr/${state.assrId}`, {
        supplier_id: state.supplierId,
        supplier: CFG.SUPPLIER_NAME,
      });

      // Auto-PO
      const po = await apiJson<{ po_no: string }>(api, "POST", `/api/assr/${state.assrId}/generate-po`);
      expect(po.po_no).toMatch(/^APO\/\d{4}-\d{3}$/);

      // Cost fields
      await apiJson(api, "PATCH", `/api/assr/${state.assrId}`, {
        po_amount: 450.0,
        supplier_invoice_ref: "[E2E] SUP-INV-0042",
        cost_notes: "E2E test cost entry",
      });

      // Verify customer still can't see any of it
      const portalJson = await (
        await customerPage.request.get(`${CFG.BASE_URL}/portal/api/case`, {
          headers: { Authorization: `Bearer ${state.portalToken}` },
        })
      ).text();
      expect(portalJson).not.toContain(CFG.SUPPLIER_NAME);
      expect(portalJson).not.toContain(po.po_no);
      expect(portalJson).not.toContain("450");
      expect(portalJson).not.toContain("SUP-INV-0042");
    });

    // ── Act 10: QA approval + close ───────────────────────
    await test.step("Act 10 — Manager approves QA; case closed", async () => {
      // Mark NCR + approve QA
      await apiJson(api, "PATCH", `/api/assr/${state.assrId}`, { ncr_category: "workmanship" });
      await apiJson(api, "POST",  `/api/assr/${state.assrId}/approve`, { quality_review_passed: true });

      // Advance remaining stages to close
      await apiJson(api, "POST", `/api/assr/${state.assrId}/transition`, { stage: "resolution" });
      await apiJson(api, "POST", `/api/assr/${state.assrId}/transition`, { stage: "closed" });

      // Customer sees Completed
      await customerPage.reload({ waitUntil: "networkidle" });
      await waitForText(customerPage, "Completed");

      // Comment box is gone on closed cases
      const commentBox = customerPage.getByPlaceholder(/Our team will see/i);
      await expect(commentBox).toHaveCount(0);
    });

    // ── Act 11: satisfaction survey ───────────────────────
    await test.step("Act 11 — Customer submits satisfaction survey", async () => {
      const s = await apiJson<{ token: string }>(api, "POST", `/api/assr/${state.assrId}/survey-token`);
      const surveyUrl = `${CFG.BASE_URL}/survey/${s.token}`;

      await customerPage.goto(surveyUrl);

      // Click the 4th star (aria-label=4 stars)
      await customerPage.getByRole("button", { name: /4 stars/i }).click();
      await customerPage.locator("textarea").fill("[E2E TEST] Quick response, friendly team");
      const [, submitResp] = await Promise.all([
        customerPage.getByRole("button", { name: /Submit Feedback/i }).click(),
        customerPage.waitForResponse((r) => r.url().includes("/survey/") && r.request().method() === "POST"),
      ]);
      expect(submitResp.status()).toBe(200);

      await waitForText(customerPage, /Thank you/i);

      // Verify on case
      const detail = await apiJson<any>(api, "GET", `/api/assr/${state.assrId}`);
      expect(detail.case.satisfaction_rating).toBe(4);
    });

    // ── Act 12: public /track form (happy + sad path) ─────
    await test.step("Act 12 — Public /track: valid + invalid lookups", async () => {
      // Sad path 1: wrong case
      const bad1 = await customerPage.request.post(`${CFG.BASE_URL}/track`, {
        data: { assr_no: "ASSR/9999-999", phone: CFG.SO_PHONE },
      });
      expect(bad1.status()).toBe(404);

      // Sad path 2: right case, wrong phone
      const bad2 = await customerPage.request.post(`${CFG.BASE_URL}/track`, {
        data: { assr_no: state.assrNo, phone: "00000000" },
      });
      expect(bad2.status()).toBe(404);

      // Happy path: real case + real phone (various formatting)
      const ok = await customerPage.request.post(`${CFG.BASE_URL}/track`, {
        data: { assr_no: state.assrNo, phone: CFG.SO_PHONE },
      });
      expect(ok.status()).toBe(200);
      const okJson = await ok.json();
      expect(okJson.token).toBeTruthy();
      expect(okJson.assr_no).toBe(state.assrNo);
    });

    // ── Act 13: cross-realm security ──────────────────────
    await test.step("Act 13 — Security boundaries", async () => {
      // Portal token cannot hit staff API
      const r1 = await customerPage.request.get(`${CFG.API_URL}/api/orders`, {
        headers: { Authorization: `Bearer ${state.portalToken}` },
      });
      expect(r1.status()).toBe(401);

      // Random bearer on portal
      const r2 = await customerPage.request.get(`${CFG.BASE_URL}/portal/api/case`, {
        headers: { Authorization: "Bearer definitely-not-a-real-token" },
      });
      expect(r2.status()).toBe(401);

      // Missing auth on portal
      const r3 = await customerPage.request.get(`${CFG.BASE_URL}/portal/api/case`);
      expect(r3.status()).toBe(401);
    });

    // ── Act 14: quality metrics (smoke) ───────────────────
    await test.step("Act 14 — Quality Metrics dashboard responds", async () => {
      const m = await apiJson<any>(api, "GET", "/api/assr/metrics?since_days=90");
      expect(m.headline).toBeTruthy();
      expect(Array.isArray(m.ncr)).toBe(true);
      expect(Array.isArray(m.supplier_performance)).toBe(true);
      // Our test case contributed at least one to the window
      expect(m.headline.total).toBeGreaterThan(0);
    });
  });
});
