// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listBundled: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

describe("PluginManager install source", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPluginsApi.list.mockResolvedValue([]);
    mockPluginsApi.listBundled.mockResolvedValue([]);
    mockPluginsApi.install.mockResolvedValue({ id: "plugin-1" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("submits a host filesystem package as localPath without invoking npm semantics", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginManager />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => button("Install Plugin").click());
    await act(async () => button("Local path").click());

    const input = document.querySelector<HTMLInputElement>("#pluginLocalPath");
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "/opt/paperclip/plugins/gloops.policy");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => button("Install").click());
    await flushReact();

    expect(mockPluginsApi.install).toHaveBeenCalledWith({
      packageName: "/opt/paperclip/plugins/gloops.policy",
      version: undefined,
      isLocalPath: true,
    });

    await act(async () => root.unmount());
  });
});
