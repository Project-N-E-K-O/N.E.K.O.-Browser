import { useTranslation } from "@browser-skill/i18n/react";
import { RiStopCircleLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import { BrowserControlIcon } from "./BrowserControlIcon";
import { replaceAgentTerms, useCurrentCatgirlProfileName } from "./profile-name";

export interface ControlOverlayProps {
  visible: boolean;
  interrupting: boolean;
  automationBypass: boolean;
  onInterrupt: () => void;
}

export function formatControlStatus(localizedStatus: string, profileName: string): string {
  const normalizedName = profileName.trim();
  const statusWithoutAgent = localizedStatus.replace(/^Agent(?=\s|$)\s*/i, "").trim();
  if (!normalizedName) {
    return statusWithoutAgent;
  }
  if (/^Agent(?=\s|$)/i.test(localizedStatus)) {
    return replaceAgentTerms(localizedStatus, normalizedName).trim();
  }
  return `${normalizedName} ${statusWithoutAgent}`.trim();
}

const CONTROL_OVERLAY_STYLES = `
  @keyframes neko-control-breathe {
    0%, 100% {
      box-shadow: inset 0 0 18px 3px rgba(64, 197, 241, 0.18);
    }
    50% {
      box-shadow: inset 0 0 42px 8px rgba(24, 167, 255, 0.38);
    }
  }

  .neko-control-glow {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    pointer-events: none;
    opacity: 0;
    animation: neko-control-breathe 3s ease-in-out infinite;
    transition: opacity 260ms ease-out;
  }

  .neko-control-glow[data-visible="true"] {
    opacity: 1;
  }

  .neko-control-blocker {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    background: transparent;
    opacity: 0;
    transition: opacity 260ms ease-out;
  }

  .neko-control-blocker[data-visible="true"] {
    opacity: 1;
  }

  .neko-control-pill {
    position: fixed;
    bottom: max(24px, env(safe-area-inset-bottom));
    left: 50%;
    z-index: 2147483647;
    display: flex;
    min-height: 52px;
    max-width: calc(100vw - 24px);
    align-items: center;
    gap: 8px;
    padding: 7px;
    border: 1px solid rgba(64, 197, 241, 0.32);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 253, 255, 0.97));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.96),
      0 12px 28px rgba(40, 139, 192, 0.18),
      0 3px 9px rgba(18, 60, 87, 0.1);
    color: #174a68;
    font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", Arial, sans-serif;
    opacity: 0;
    transform: translate(-50%, 8px) scale(0.98);
    transition:
      opacity 220ms ease-out,
      transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
    backdrop-filter: blur(14px) saturate(135%);
  }

  .neko-control-pill[data-visible="true"] {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }

  .neko-control-brand {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 9px;
    padding-left: 2px;
  }

  .neko-control-icon-shell {
    display: grid;
    width: 29px;
    height: 29px;
    flex: 0 0 29px;
    place-items: center;
    overflow: visible;
  }

  .neko-control-icon {
    display: block;
    width: 29px;
    height: 29px;
    color: #18a7ff;
    user-select: none;
    -webkit-user-drag: none;
  }

  .neko-control-status {
    overflow: hidden;
    color: #174a68;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.01em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: none;
  }

  .neko-control-stop {
    display: flex;
    min-height: 36px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 8px 15px 8px 13px;
    border: 1px solid #c64557;
    border-radius: 999px;
    background: linear-gradient(90deg, #f27988, #e45f70);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.34),
      0 5px 12px rgba(228, 95, 112, 0.2);
    color: #fff;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
      transform 140ms ease,
      border-color 140ms ease,
      background 140ms ease,
      box-shadow 140ms ease,
      opacity 140ms ease;
  }

  .neko-control-stop:hover:not(:disabled) {
    background: linear-gradient(90deg, #f58794, #c64557);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.38),
      0 7px 16px rgba(228, 95, 112, 0.28);
    transform: translateY(-1px);
  }

  .neko-control-stop:active:not(:disabled) {
    transform: translateY(0) scale(0.98);
  }

  .neko-control-stop:focus-visible {
    outline: 2px solid #40c5f1;
    outline-offset: 2px;
    box-shadow:
      0 0 0 4px rgba(64, 197, 241, 0.2),
      0 5px 12px rgba(228, 95, 112, 0.2);
  }

  .neko-control-stop:disabled {
    border-color: #879cab;
    background: linear-gradient(90deg, #aebec8, #879cab);
    box-shadow: none;
    cursor: wait;
    opacity: 0.72;
  }

  @media (prefers-color-scheme: dark) {
    .neko-control-pill {
      border-color: rgba(114, 207, 255, 0.3);
      background: linear-gradient(180deg, rgba(30, 42, 54, 0.98), rgba(24, 35, 47, 0.98));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 12px 28px rgba(0, 0, 0, 0.3);
      color: #dff4ff;
    }

    .neko-control-icon {
      color: #5ddcff;
    }

    .neko-control-status {
      color: #dff4ff;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .neko-control-glow {
      animation: none;
      box-shadow: inset 0 0 24px 4px rgba(64, 197, 241, 0.24);
    }

    .neko-control-glow,
    .neko-control-blocker,
    .neko-control-pill,
    .neko-control-stop {
      transition: none;
    }
  }
`;

export function ControlOverlay({
  visible,
  interrupting,
  automationBypass,
  onInterrupt,
}: ControlOverlayProps) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);
  const profileName = useCurrentCatgirlProfileName(visible);
  const blockerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [visible]);

  useEffect(() => {
    const blocker = blockerRef.current;
    if (!blocker) return;
    const stopScroll = (event: WheelEvent | TouchEvent) => {
      if (automationBypass) return;
      event.preventDefault();
      event.stopPropagation();
    };
    blocker.addEventListener("wheel", stopScroll, { passive: false });
    blocker.addEventListener("touchmove", stopScroll, { passive: false });
    return () => {
      blocker.removeEventListener("wheel", stopScroll);
      blocker.removeEventListener("touchmove", stopScroll);
    };
  }, [automationBypass]);

  useEffect(() => {
    if (!visible || automationBypass) return;
    const stopScroll = (event: WheelEvent | TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("wheel", stopScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", stopScroll, { capture: true, passive: false });
    return () => {
      window.removeEventListener("wheel", stopScroll, { capture: true });
      window.removeEventListener("touchmove", stopScroll, { capture: true });
    };
  }, [visible, automationBypass]);

  if (!visible) return null;

  const pointerEvents = automationBypass ? "none" : "auto";
  const statusText = formatControlStatus(t("controlOverlay.status"), profileName);

  return (
    <>
      <style>{CONTROL_OVERLAY_STYLES}</style>

      <div
        className="neko-control-glow"
        data-slot="control-overlay"
        data-visible={show ? "true" : "false"}
      />

      <div
        ref={blockerRef}
        className="neko-control-blocker"
        data-slot="control-overlay-blocker"
        data-visible={show ? "true" : "false"}
        onPointerDown={(event) => {
          if (automationBypass) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          if (automationBypass) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{ pointerEvents }}
      />

      <div
        className="neko-control-pill"
        data-slot="control-overlay-pill"
        data-visible={show ? "true" : "false"}
        style={{ pointerEvents: "auto" }}
      >
        <div className="neko-control-brand">
          <span className="neko-control-icon-shell">
            <BrowserControlIcon className="neko-control-icon" />
          </span>
          <span className="neko-control-status" aria-live="polite" title={statusText}>
            {statusText}
          </span>
        </div>
        <button
          type="button"
          className="neko-control-stop"
          data-slot="control-overlay-stop-all"
          disabled={interrupting}
          onClick={onInterrupt}
          style={{ pointerEvents: "auto" }}
        >
          <RiStopCircleLine size={17} aria-hidden="true" />
          {interrupting ? t("controlOverlay.interrupting") : t("controlOverlay.interrupt")}
        </button>
      </div>
    </>
  );
}
