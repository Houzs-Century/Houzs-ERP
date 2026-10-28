import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isSkippableStagingErrorForPolicy,
  missingCredentialsMaySkip,
  StagingAuthUnprovisionedError,
  StagingUnavailableError,
} from "./fixtures";

test.describe("staging proof policy", () => {
  test("optional local runs may skip known setup and availability gaps", () => {
    expect(
      isSkippableStagingErrorForPolicy(new StagingUnavailableError(), false),
    ).toBe(true);
    expect(
      isSkippableStagingErrorForPolicy(
        new StagingAuthUnprovisionedError(),
        false,
      ),
    ).toBe(true);
  });

  test("required automated proofs fail closed", () => {
    expect(
      isSkippableStagingErrorForPolicy(new StagingUnavailableError(), true),
    ).toBe(false);
    expect(
      isSkippableStagingErrorForPolicy(
        new StagingAuthUnprovisionedError(),
        true,
      ),
    ).toBe(false);
    expect(isSkippableStagingErrorForPolicy(new Error("unexpected"), false)).toBe(
      false,
    );
    expect(missingCredentialsMaySkip(true, true)).toBe(false);
    expect(() => missingCredentialsMaySkip(false, true)).toThrow(
      /Required staging proof has no usable credentials/,
    );
  });

  test("optional local runs may skip when credentials are absent", () => {
    expect(missingCredentialsMaySkip(false, false)).toBe(true);
  });

  test("the automated workflow cannot silently drop proof or test different source", () => {
    const workflowPath = resolve(
      __dirname,
      "../../.github/workflows/staging-e2e.yml",
    );
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain('STAGING_E2E_REQUIRE_PROOF: "true"');
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
    );
  });
});
