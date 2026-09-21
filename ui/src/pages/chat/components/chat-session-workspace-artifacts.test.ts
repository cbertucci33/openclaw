import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gatewayHello,
  loadedSidebarContent,
  createSidebarContentRecorder,
} from "./chat-session-workspace.test-support.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

describe("session workspace artifacts", () => {
  afterEach(() => vi.unstubAllGlobals());

  function createArtifactHost(params: {
    data: string;
    mimeType: string;
    title?: string;
    http?: boolean;
  }) {
    const handleOpenSidebar = createSidebarContentRecorder();
    const url = "/api/artifacts/download/connection/ticket";
    const request = vi.fn().mockResolvedValue({
      artifact: {
        id: "artifact-1",
        mimeType: params.mimeType,
        title: params.title ?? "Unicode artifact",
      },
      ...(params.http ? { url } : { data: params.data, encoding: "base64" }),
    });
    const fetchMock = vi.fn(async () => {
      const bytes = Uint8Array.from(atob(params.data), (char) => char.charCodeAt(0));
      return {
        ok: true,
        blob: async () =>
          params.mimeType.startsWith("image/")
            ? new Blob([bytes], { type: params.mimeType })
            : {
                type: params.mimeType.split(";", 1)[0]?.toLowerCase(),
                text: async () => new TextDecoder().decode(bytes),
              },
      };
    });
    if (params.http) {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal("fetch", fetchMock);
    }
    const state = {
      client: { request, gatewayUrl: "wss://control.test" },
      connected: true,
      resourceBasePath: "/mount",
      handleOpenSidebar,
      hello: gatewayHello([]),
      sessionKey: "agent:main:current",
      sidebarContent: null,
      sessions: {},
    } as unknown as SessionWorkspaceHost;
    return { handleOpenSidebar, request, state, fetchMock, url: `/mount${url}` };
  }

  it.each([true, false])(
    "uses artifact titles without changing tab identity (listed: %s)",
    async (listed) => {
      const { state, request } = createArtifactHost({
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        title: "resolved-image.png",
      });
      const props = createSessionWorkspaceProps(state);
      const workspace = state.sessionWorkspaceState!;
      if (listed) {
        workspace.list = {
          sessionKey: state.sessionKey,
          files: [],
          artifacts: [
            {
              id: "artifact-1",
              title: "listed-image.png",
              type: "image",
              mimeType: "image/png",
              download: { mode: "bytes" },
            },
          ],
        };
      }
      props.onOpenArtifact("artifact-1");
      const preview = workspace.previews[0]!;
      expect(preview.label).toBe(listed ? "listed-image.png" : "Artifacts");
      await loadedSidebarContent(state);
      expect(preview.label).toBe("resolved-image.png");
      props.onOpenArtifact("artifact-1");
      expect(workspace.previews).toEqual([preview]);
      expect(preview.id).toBe("artifact:artifact-1");
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("keeps nested code literal in a decoded text artifact preview", async () => {
    const source = [
      "Résumé 東京 🦀",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "**literal after**",
    ].join("\n");
    const { state } = createArtifactHost({
      data: btoa(String.fromCharCode(...new TextEncoder().encode(source))),
      mimeType: "text/markdown",
      title: "Source notes",
    });
    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");
    const content = await loadedSidebarContent(state);
    expect(content).toMatchObject({ kind: "markdown", rawText: source });
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      updateComplete: Promise<unknown>;
    };
    panel.content = content;
    document.body.append(panel);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await panel.updateComplete;
      const reader = panel.querySelector(".sidebar-markdown-reader");
      expect(reader?.querySelector("h1")?.textContent).toBe("Source notes");
      expect.soft(reader?.querySelectorAll("pre code")).toHaveLength(1);
      expect.soft(reader?.querySelector("pre code")?.textContent).toBe(`${source}\n`);
      expect.soft(reader?.querySelector("strong")).toBeNull();
      const copyButton = reader?.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledWith(source);
    } finally {
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      panel.remove();
    }
  });

  it.each(
    [
      {
        content: "Résumé 東京 🦀",
        fence: "```",
        mimeType: "text/plain",
      },
      {
        content: "Résumé 東京 🦀",
        fence: "```",
        mimeType: "text/plain; charset=utf-8",
      },
      {
        content: JSON.stringify({ message: "Résumé 東京 🦀" }),
        fence: "```json",
        mimeType: "application/json",
      },
    ].flatMap((testCase) => [false, true].map((http) => Object.assign({ http }, testCase))),
  )(
    "decodes UTF-8 $mimeType artifacts without corrupting visible or raw text (HTTP: $http)",
    async (testCase) => {
      const data = btoa(String.fromCharCode(...new TextEncoder().encode(testCase.content)));
      const { state, fetchMock, url } = createArtifactHost({
        data,
        mimeType: testCase.mimeType,
        http: testCase.http,
      });

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      expect(await loadedSidebarContent(state)).toEqual({
        kind: "markdown",
        content: `# Unicode artifact\n\n${testCase.fence}\n${testCase.content}\n\`\`\``,
        rawText: testCase.content,
      });
      if (testCase.http) {
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it.each([false, true])(
    "retains image artifact previews beyond ticket expiry (HTTP: %s)",
    async (http) => {
      const data = "iVBORw0KGgo=";
      const { state, fetchMock, url } = createArtifactHost({
        data,
        mimeType: "image/png",
        title: "preview.png",
        http,
      });

      createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

      expect(await loadedSidebarContent(state)).toEqual({
        kind: "image",
        mimeType: "image/png",
        rawText: http ? url : null,
        src: `data:image/png;base64,${data}`,
        title: "preview.png",
      });
      if (http) {
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it("reports malformed base64 artifact data as a visible workspace error", async () => {
    const { handleOpenSidebar, state } = createArtifactHost({
      data: "not-base64!",
      mimeType: "text/plain",
    });

    createSessionWorkspaceProps(state).onOpenArtifact("artifact-1");

    await vi.waitFor(() =>
      expect(createSessionWorkspaceProps(state).error).toMatch(/InvalidCharacterError|invalid/i),
    );
    expect(handleOpenSidebar).toHaveBeenCalledOnce();
    expect(state.sessionWorkspaceState?.previews.at(-1)?.content).toMatchObject({
      kind: "unavailable",
    });
  });
});
