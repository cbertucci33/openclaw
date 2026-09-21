import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  bindOperatorModelExecution,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Native selection changes stay bound to the original host source and foreground lifetime. */
export function bindHarnessModelExecution(
  admittedRunContext: AdmittedRunContext,
  model: ModelRef | undefined,
  assertActive: () => void,
  hostSignal: AbortSignal,
): ReturnType<NonNullable<AgentHarnessHostCapabilities["bindModelExecution"]>> {
  assertActive();
  const execution = bindOperatorModelExecution(
    readAdmittedRunOperatorAuthority(admittedRunContext),
    model,
  );
  if (!execution) {
    return undefined;
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      hostSignal.removeEventListener("abort", release);
      execution.release();
    }
  };
  const signal = AbortSignal.any([hostSignal, execution.signal]);
  hostSignal.addEventListener("abort", release, { once: true });
  if (hostSignal.aborted) {
    release();
  }
  return Object.freeze({
    signal,
    assertCurrent: () => {
      assertActive();
      signal.throwIfAborted();
      if (released) {
        throw new Error("agent harness model execution is no longer active");
      }
      execution.assertCurrent();
    },
    release,
  });
}

const retainedSources = resolveGlobalSingleton(
  Symbol.for("openclaw.harness.retainedSources"),
  () => new Set<AbortController>(),
);
registerAgentEventLifecycleRotationHandler("harness-retained-sources", () => {
  const retiring = [...retainedSources];
  retainedSources.clear();
  for (const controller of retiring) {
    controller.abort(new Error("agent harness retained source is no longer active"));
  }
});

/** Transfers original-source custody while the issuing foreground host is still live. */
export function retainHarnessSource(
  admittedRunContext: AdmittedRunContext,
  assertActive: () => void,
): ReturnType<NonNullable<AgentHarnessHostCapabilities["retainSourceAuthority"]>> {
  assertActive();
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  const source = readAdmittedRunOperatorAuthority(admittedRunContext);
  if (!source) {
    return undefined;
  }
  const release = source.retain?.();
  try {
    assertActive();
    source.assertCurrent();
    assertActive();
  } catch (error) {
    release?.();
    throw error;
  }
  let released = false;
  const lifecycle = new AbortController();
  retainedSources.add(lifecycle);
  const signal = source.signal
    ? AbortSignal.any([source.signal, lifecycle.signal])
    : lifecycle.signal;
  const assertRetained = () => {
    if (released || getAgentRunLifecycleGeneration() !== lifecycleGeneration) {
      throw new Error("agent harness retained source is no longer active");
    }
    signal.throwIfAborted();
  };
  return Object.freeze({
    signal,
    assertCurrent: () => {
      assertRetained();
      source.assertCurrent();
      assertRetained();
    },
    release: () => {
      if (!released) {
        released = true;
        retainedSources.delete(lifecycle);
        release?.();
      }
    },
  });
}
