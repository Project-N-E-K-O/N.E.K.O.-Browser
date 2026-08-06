import { WSTransport } from "@/transport/ws-transport";
import type { ProtocolFrame, RequestFrame, ResponseFrame } from "@/transport/types";

type AutomationMode = "pointer-bypass" | "capture-hide" | "record-passthrough";

interface ToolLease {
  leaseId: string;
  mode: AutomationMode;
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

const toolLeases = new WeakMap<WSTransport, Map<string, ToolLease>>();
const TAB_MESSAGE_ACK_TIMEOUT_MS = 750;
let installed = false;
let startupReset: Promise<void> = Promise.resolve();

function isRequestFrame(frame: ProtocolFrame): frame is RequestFrame {
  return "id" in frame && "method" in frame;
}

function isResponseFrame(frame: ProtocolFrame): frame is ResponseFrame {
  return "id" in frame && ("result" in frame || "error" in frame);
}

async function sendTabMessageWithDeadline(tabId: number, message: unknown): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TAB_MESSAGE_ACK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Restricted, frozen, and tabs without the N.E.K.O content script are expected.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function broadcastAutomationLease(
  leaseId: string,
  mode: AutomationMode,
  active: boolean,
): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number") return;
      await sendTabMessageWithDeadline(tab.id, {
        type: "NEKO_AUTOMATION_LEASE",
        leaseId,
        mode,
        active,
      });
    }),
  );
}

async function resetStaleAutomationLeases(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number") return;
      await sendTabMessageWithDeadline(tab.id, {
        type: "NEKO_AUTOMATION_LEASE_RESET",
      });
    }),
  );
}

function leaseMap(transport: WSTransport): Map<string, ToolLease> {
  let leases = toolLeases.get(transport);
  if (!leases) {
    leases = new Map();
    toolLeases.set(transport, leases);
  }
  return leases;
}

function prepareAutomation(
  transport: WSTransport,
  requestId: string,
  mode: AutomationMode,
  label: string,
): Promise<void> {
  const leases = leaseMap(transport);
  const existing = leases.get(requestId);
  if (existing) return existing.ready;

  const leaseId = `bsk-${label}:${requestId}`;
  const ready = startupReset.then(() =>
    broadcastAutomationLease(leaseId, mode, true),
  );
  const timer = setTimeout(() => {
    releaseAutomation(transport, requestId);
  }, 30_000);
  leases.set(requestId, { leaseId, mode, ready, timer });
  return ready;
}

function releaseAutomation(transport: WSTransport, requestId: string): void {
  const leases = leaseMap(transport);
  const lease = leases.get(requestId);
  if (!lease) return;
  leases.delete(requestId);
  clearTimeout(lease.timer);
  // Restore tabs that already accepted the activation immediately, then send
  // a second release after any late activation settles to close the race.
  void broadcastAutomationLease(lease.leaseId, lease.mode, false);
  void lease.ready.then(
    () => broadcastAutomationLease(lease.leaseId, lease.mode, false),
    () => broadcastAutomationLease(lease.leaseId, lease.mode, false),
  );
}

function releaseAllAutomation(transport: WSTransport): void {
  for (const requestId of leaseMap(transport).keys()) {
    releaseAutomation(transport, requestId);
  }
}

export function installBrowserSkillIntegration(): void {
  if (installed) return;
  installed = true;

  // MV3 can terminate the service worker in the middle of a click, capture,
  // or recording. BrowserSkill cannot resume those in-memory operations after
  // a restart, so restore every already-loaded N.E.K.O surface immediately.
  startupReset = resetStaleAutomationLeases().catch((error) => {
    console.debug("[neko/browser-skill] stale lease reset failed", error);
  });

  const originalOnMessage = WSTransport.prototype.onMessage;
  WSTransport.prototype.onMessage = function onMessage(handler) {
    // Keep each subscriber's wire order intact while an automation surface is
    // being prepared. In particular, a cancel received behind a delayed click
    // must run only after the click has reached ToolDispatcher and registered
    // its AbortController.
    let dispatchTail = Promise.resolve();
    return originalOnMessage.call(this, (frame) => {
      let ready = Promise.resolve();
      if (isRequestFrame(frame) && frame.method === "tool.screenshot") {
        ready = prepareAutomation(this, frame.id, "capture-hide", "screenshot");
      } else if (isRequestFrame(frame) && frame.method === "tool.click") {
        ready = prepareAutomation(this, frame.id, "pointer-bypass", "click");
      } else if (isRequestFrame(frame) && frame.method === "tool.record_start") {
        ready = startupReset;
      }
      dispatchTail = dispatchTail
        .then(() => ready)
        .then(() => handler(frame))
        .catch((error) => {
          console.error("[neko/browser-skill] ordered transport handler failed", error);
        });
    });
  };

  const originalSend = WSTransport.prototype.send;
  WSTransport.prototype.send = function send(frame) {
    try {
      originalSend.call(this, frame);
    } finally {
      if (isResponseFrame(frame)) releaseAutomation(this, frame.id);
    }
  };

  const originalDisconnect = WSTransport.prototype.disconnect;
  WSTransport.prototype.disconnect = async function disconnect() {
    releaseAllAutomation(this);
    await originalDisconnect.call(this);
  };
}
