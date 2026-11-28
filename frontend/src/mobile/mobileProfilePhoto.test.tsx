import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPutBinary, apiFetchBlobUrl, authUser, prepared } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPutBinary: vi.fn(),
  apiFetchBlobUrl: vi.fn(),
  authUser: { current: null as unknown },
  prepared: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    get: apiGet,
    post: apiPost,
    patch: vi.fn(),
    del: vi.fn(),
    putBinary: apiPutBinary,
    fetchBlobUrl: apiFetchBlobUrl,
  },
}));

vi.mock("../lib/imagePipeline", () => ({ prepareImageForUpload: prepared }));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: authUser.current,
    reload: vi.fn(),
    logout: vi.fn(),
    can: () => true,
    pageAccess: {},
  }),
}));

vi.mock("./useAnnouncementUnread", () => ({ useAnnouncementUnread: () => 0 }));

vi.mock("../lib/nativeSession", () => ({
  biometricSessionEnabled: () => false,
  setBiometricSessionEnabled: vi.fn(),
  nativeBiometricSupported: () => Promise.resolve(false),
  rememberNativeSession: vi.fn(),
  forgetNativeSession: vi.fn(),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileProfile } from "./MobileProfile";

afterEach(cleanup);

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPutBinary.mockReset();
  apiFetchBlobUrl.mockReset();
  prepared.mockReset();

  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/totp/status")) return { enabled: false, backup_codes_remaining: 0 };
    if (path.startsWith("/api/users")) return { users: [] };
    if (path.startsWith("/api/scm/mfg-sales-orders/my-mtd")) return { mtd_orders: 0, mtd_sales_sen: 0 };
    if (path.startsWith("/api/assr/my-cases")) return { cases: [] };
    return {};
  });
  apiFetchBlobUrl.mockResolvedValue("blob:mock-profile-pic");
  apiPutBinary.mockResolvedValue({ ok: true });
  prepared.mockImplementation(async (file: File) => ({ file }));

  authUser.current = {
    id: 7,
    name: "Wei Siang",
    email: "wei@example.com",
    role_name: "Sales",
    status: "active",
    profile_pic_r2_key: null,
  };
});

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileProfile onLogout={() => {}} />
    </QueryClientProvider>,
  );
};

describe("MobileProfile — profile photo", () => {
  it("DISPLAYS a photo uploaded from a PC instead of falling back to initials", async () => {
    (authUser.current as Record<string, unknown>).profile_pic_r2_key = "1723459200-wei.jpg";
    wrap();

    const img = (await screen.findByAltText(/wei siang/i)) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toContain("blob:mock-profile-pic");
    expect(apiFetchBlobUrl.mock.calls.some((c) => String(c[0]).includes("/api/users/7/profile-pic"))).toBe(true);
  });

  it("shows a TEAMMATE's photo in My Team — the roster threw the key away", async () => {
    (authUser.current as Record<string, unknown>).role_name = "Sales Executive";
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/totp/status")) return { enabled: false, backup_codes_remaining: 0 };
      if (path.startsWith("/api/users")) {
        return {
          users: [
            { id: 7, email: "wei@example.com", name: "Wei Siang", role_name: "Sales Executive" },
            { id: 9, email: "amy@example.com", name: "Amy Tan", role_name: "Sales Executive",
              manager_id: 7, profile_pic_r2_key: "1723459200-amy.jpg" },
          ],
        };
      }
      if (path.startsWith("/api/scm/mfg-sales-orders/my-mtd")) return { mtd_orders: 0, mtd_sales_sen: 0 };
      if (path.startsWith("/api/assr/my-cases")) return { cases: [] };
      return {};
    });

    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByText("My Team"));

    const img = (await screen.findByAltText(/amy tan/i)) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(apiFetchBlobUrl.mock.calls.some((c) => String(c[0]).includes("/api/users/9/profile-pic"))).toBe(true);
  });

  it("UPLOADS a photo through the shared desktop path, limits included", async () => {
    const user = userEvent.setup();
    wrap();

    const input = (await screen.findByLabelText("Profile photo")) as HTMLInputElement;
    expect(input.accept).toContain("image/");

    const file = new File([new Uint8Array([1, 2, 3])], "selfie.jpg", { type: "image/jpeg" });
    await user.upload(input, file);

    await waitFor(() => expect(prepared).toHaveBeenCalled());
    expect(prepared.mock.calls[0]?.[1]).toMatchObject({ maxDimension: 1000 });

    await waitFor(() => expect(apiPutBinary).toHaveBeenCalled());
    expect(String(apiPutBinary.mock.calls[0]?.[0])).toContain("/api/users/me/profile-pic");
  });

  it("refuses an oversized image with the desktop's own 5 MB limit", async () => {
    const user = userEvent.setup();
    prepared.mockImplementation(async () => {
      const f = new File([new Uint8Array(1)], "huge.jpg", { type: "image/jpeg" });
      Object.defineProperty(f, "size", { value: 6 * 1024 * 1024 });
      return { file: f };
    });

    wrap();
    const input = (await screen.findByLabelText("Profile photo")) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "huge.jpg", { type: "image/jpeg" });
    await user.upload(input, file);

    await waitFor(() => expect(prepared).toHaveBeenCalled());
    expect(apiPutBinary).not.toHaveBeenCalled();
  });
});
