import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";

it("rejects restricted native inference before invoking a harness without exact model-policy support", async () => {
  const cfg = { agents: { defaults: { model: "fixture/a" } } };
  const source = createAdmittedRunOperatorAuthority({
    profileId: "native-unaware-fixture",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] }),
  });
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "native-unaware",
    "main",
    "test",
    undefined,
    source,
  );
  const runAttempt = vi.fn(async () => {
    throw new Error("unsupported harness must not execute");
  });
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  try {
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerAgentHarness(
      {
        id: "fixture",
        label: "Fixture",
        supports: () => ({ supported: true }),
        runAttempt,
      },
      { ownerPluginId: "fixture" },
    );
    const registration = getRegisteredAgentHarness("fixture");
    if (!registration) {
      throw new Error("missing registered fixture harness");
    }
    await expect(
      runAgentHarnessAttempt(
        createHarnessAttemptParams(await admission.admit("plugin-harness", "fixture"), cfg),
        {
          auth: "native",
          modelRef: { provider: "fixture", model: "a" },
          assertCurrent: async () => {},
          harness: registration.harness,
        },
      ),
    ).rejects.toThrow("cannot enforce your operator role's model policy");
    expect(runAttempt).not.toHaveBeenCalled();
  } finally {
    admission.close();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
});

it("binds native models to the original source without revoking surviving models or nonmodel work", async () => {
  const cfg = {
    agents: { defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } } },
  };
  let policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
  const listeners = new Set<() => void>();
  const sourceAbort = new AbortController();
  const source = createAdmittedRunOperatorAuthority({
    profileId: "native-model-fixture",
    scopes: ["operator.write"],
    signal: sourceAbort.signal,
    assertCurrent: () => {},
    get modelPolicy() {
      return policy;
    },
    onModelPolicyChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "native-model-execution",
    "main",
    "test",
    undefined,
    source,
  );
  const host = createAgentHarnessHostCapabilities({
    attempt: {
      admittedRunContext: await admission.admit("plugin-harness", "fixture"),
      runId: "native-model-execution",
      agentId: "main",
    },
    pluginId: "fixture",
  });
  try {
    const bind = host.capabilities.bindModelExecution;
    if (!bind) {
      throw new Error("missing host model execution capability");
    }
    expect(() => bind({ provider: "fixture", model: "denied" })).toThrow(
      "operator role cannot use this model",
    );
    const a = bind({ provider: "fixture", model: "a" });
    const b = bind({ provider: "fixture", model: "b" });
    if (!a || !b) {
      throw new Error("missing operator model execution binding");
    }
    policy = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["fixture/a"] },
      manifestPlugins: [],
    });
    for (const listener of listeners) {
      listener();
    }
    expect(a.signal.aborted).toBe(true);
    expect(a.assertCurrent).toThrow("operator role cannot use this model");
    expect(b.signal.aborted).toBe(false);
    expect(b.assertCurrent).not.toThrow();
    expect(sourceAbort.signal.aborted).toBe(false);
    expect(host.capabilities.assertActive).not.toThrow();
    a.release();
    b.release();
    expect(b.signal.aborted).toBe(false);
    expect(b.assertCurrent).toThrow("no longer active");
    const current = bind({ provider: "fixture", model: "b" });
    if (!current) {
      throw new Error("missing operator model execution binding");
    }
    host.close();
    expect(current.signal.aborted).toBe(true);
    expect(current.assertCurrent).toThrow("no longer active");
    expect(listeners.size).toBe(0);
    expect(source.assertCurrent).not.toThrow();
  } finally {
    host.close();
    admission.close();
  }
});
