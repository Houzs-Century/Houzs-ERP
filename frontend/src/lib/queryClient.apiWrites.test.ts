// A write through api.post/patch/put/del marks the hooks/useQuery reads stale and drops the read cache, including
// reads of another resource (port of Conts D22). Timer and on-mount writes that change nothing on screen do not.
import { describe, expect, test } from "vitest";
import { queryClient } from "./queryClient";
import { getCached, invalidateForMutation, setCached } from "../api/cache";

describe("a plain api write refreshes the hooks/useQuery reads", () => {
  test("archiving a project marks another resource's list stale and drops its cached copy", () => {
    queryClient.setQueryData(["uq", "/api/service-cases", "open"], { data: [] });
    queryClient.setQueryData(["grns-paged", "g-1"], { id: "g-1" });
    setCached("/api/service-cases?status=open", { data: [] });
    invalidateForMutation("/api/projects/7/archive");
    expect(queryClient.getQueryState(["uq", "/api/service-cases", "open"])?.isInvalidated).toBe(true);
    expect(getCached("/api/service-cases?status=open")).toBeUndefined();
    expect(queryClient.getQueryState(["grns-paged", "g-1"])?.isInvalidated).toBe(false);
  });

  test.each([
    "/api/presence/heartbeat",
    "/api/projects/7/read",
    "/api/mail-center/threads/t-1/replying",
  ])("%s refreshes nothing", (path) => {
    queryClient.setQueryData(["uq", "/api/users"], []);
    setCached("/api/users", []);
    invalidateForMutation(path);
    expect(queryClient.getQueryState(["uq", "/api/users"])?.isInvalidated).toBe(false);
    expect(getCached("/api/users")).toEqual([]);
  });
});
