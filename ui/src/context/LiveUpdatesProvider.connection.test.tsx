// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
vi.mock("./CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { id: "company" } }) }));
vi.mock("./ToastContext", () => { const pushToast = () => {}; return { useToastActions: () => ({ pushToast }) }; });
vi.mock("../lib/router", () => ({ useLocation: () => ({ pathname: "/companyos/work" }) }));
vi.mock("../api/health", () => ({ healthApi: { get: async () => ({ deploymentMode: "authenticated" }) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "human" }, session: { id: "session" } }) } }));
import { LiveUpdatesProvider, useOverviewConnection } from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("reports disconnect and refetches the company overview prefix when the existing socket reconnects", async () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    readyState = 1;
    onopen: (() => void) | null = null; onclose: (() => void) | null = null;
    onmessage = null; onerror = null;
    constructor() { sockets.push(this); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  function Consumer() { return <p>{useOverviewConnection("company") ? "connected" : "disconnected"}</p>; }
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><Consumer /></LiveUpdatesProvider></QueryClientProvider>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(sockets).toHaveLength(1);
    await act(async () => sockets[0].onopen?.());
    expect(container.textContent).toBe("connected");
    invalidate.mockClear();
    await act(async () => sockets[0].onclose?.());
    expect(container.textContent).toBe("disconnected");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(sockets).toHaveLength(2);
    await act(async () => sockets[1].onopen?.());
    expect(invalidate).toHaveBeenCalledWith({ type: "active" }, { cancelRefetch: false });
    expect(container.textContent).toBe("connected");
  } finally { await act(async () => root.unmount()); container.remove(); client.clear(); vi.unstubAllGlobals(); }
});
