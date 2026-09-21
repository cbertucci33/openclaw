import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each(["admitted", "read-error"] as const)(
  "settles the admission observer and unsubscribes after %s",
  async (outcome) => {
    vi.useFakeTimers();
    const scope = { storePath: "/fixture/sessions.json", sessionKey: "agent:main:main" };
    const initial = { sessionId: "fixture-session", updatedAt: 1, abortedLastRun: true };
    const read = vi.mocked(loadSessionEntry).mockReturnValue(initial);
    const runtime = createRecoveryRuntimeFixture({
      callGateway: vi.fn(async () => {
        throw new Error("Unexpected Gateway call");
      }),
      getDispatchSettlement: async () => {},
      sendRecoveryNotice: async () => ({ suppressed: false }),
    });
    const failure = new Error("fixture database read failed");
    const settled = vi.fn();
    const pending = runtime.expectAdmission(0, scope).then(
      () => settled("admitted"),
      (error: unknown) => settled(error),
    );
    try {
      if (outcome === "read-error") {
        read.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        read.mockReturnValue({ ...initial, abortedLastRun: false });
      }
      sessionChanges.emit(scope);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toHaveBeenCalledExactlyOnceWith(
        outcome === "read-error" ? failure : "admitted",
      );
      read.mockClear();
      sessionChanges.emit(scope);
      expect(read).not.toHaveBeenCalled();
    } finally {
      // Let the original broken observer settle after the intended assertion fails.
      read.mockReturnValue({ ...initial, abortedLastRun: false });
      sessionChanges.emit(scope);
      await pending;
    }
  },
);
