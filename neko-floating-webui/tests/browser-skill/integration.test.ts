import { describe, expect, it, vi } from "vitest";
import { WSTransport } from "@/transport/ws-transport";
import type { ProtocolFrame } from "@/transport/types";
import { installBrowserSkillIntegration } from "../../src/browser-skill/integration";

type SocketEvent = "open" | "message" | "close" | "error";

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<SocketEvent, Array<(event: unknown) => void>>();

  addEventListener(event: SocketEvent, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  inbound(frame: ProtocolFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(event: SocketEvent, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe("BrowserSkill automation lease integration", () => {
  it("bounds unresponsive tabs while ordering reset, screenshots, and clicks", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const sendMessage = vi.fn((tabId: number, message: { type: string; active?: boolean }) => {
      if (
        tabId === 12
        && (
          message.type === "NEKO_AUTOMATION_LEASE_RESET"
          || (message.type === "NEKO_AUTOMATION_LEASE" && message.active === true)
        )
      ) {
        return never;
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 11 }, { id: 12 }, {}]),
        sendMessage,
      },
    });

    installBrowserSkillIntegration();

    const socket = new FakeWebSocket();
    const transport = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: ProtocolFrame[] = [];
    transport.onMessage((frame) => received.push(frame));

    const connected = transport.connect();
    socket.open();
    await connected;
    socket.inbound({ id: "record-1", method: "tool.record_start", params: {} });

    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(received).toHaveLength(1);

    socket.inbound({ id: "capture-1", method: "tool.screenshot", params: {} });

    await vi.advanceTimersByTimeAsync(750);
    expect(received).toHaveLength(2);
    const activationCalls = sendMessage.mock.calls.filter(
      ([, message]) => message.type === "NEKO_AUTOMATION_LEASE" && message.active === true,
    );
    expect(activationCalls).toEqual([
      [11, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId: "bsk-screenshot:capture-1",
        mode: "capture-hide",
        active: true,
      }],
      [12, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId: "bsk-screenshot:capture-1",
        mode: "capture-hide",
        active: true,
      }],
    ]);

    transport.send({ id: "capture-1", result: { data: "png" } });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(11, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId: "bsk-screenshot:capture-1",
        mode: "capture-hide",
        active: false,
      });
      expect(sendMessage).toHaveBeenCalledWith(12, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId: "bsk-screenshot:capture-1",
        mode: "capture-hide",
        active: false,
      });
    });
    expect(JSON.parse(socket.sent[0])).toEqual({ id: "capture-1", result: { data: "png" } });

    socket.inbound({ id: "click-1", method: "tool.click", params: { x: 100, y: 80 } });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(sendMessage).toHaveBeenCalledWith(11, {
      type: "NEKO_AUTOMATION_LEASE",
      leaseId: "bsk-click:click-1",
      mode: "pointer-bypass",
      active: true,
    });
    transport.send({ id: "click-1", result: { x: 100, y: 80 } });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(11, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId: "bsk-click:click-1",
        mode: "pointer-bypass",
        active: false,
      });
    });

    await transport.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
