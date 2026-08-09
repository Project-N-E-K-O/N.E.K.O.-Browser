import { i18n as browserSkillI18n } from "@browser-skill/i18n";
import { I18nextProvider, useTranslation } from "@browser-skill/i18n/react";
import {
  HelpRequestOverlay as UpstreamHelpRequestOverlay,
  type HelpRequestData,
} from "@browser-skill-upstream/content/HelpRequestOverlay";
import { useMemo } from "react";
import { replaceAgentTerms, useCurrentCatgirlProfileName } from "./profile-name";

export type { HelpRequestData };

interface HelpRequestOverlayProps {
  request: HelpRequestData | null;
}

const HELP_REQUEST_STYLES = `
  @keyframes neko-help-flash {
    0%, 100% {
      box-shadow: 0 0 0 2px rgba(64, 197, 241, 0.78), 0 0 14px 3px rgba(64, 197, 241, 0.34);
    }
    50% {
      box-shadow: 0 0 0 3px rgba(24, 167, 255, 0.92), 0 0 24px 7px rgba(24, 167, 255, 0.48);
    }
  }

  [data-slot="help-highlight"] {
    animation-name: neko-help-flash !important;
  }

  .bsk-help-banner {
    overflow: hidden;
    border: 1px solid rgba(64, 197, 241, 0.3) !important;
    border-radius: 18px !important;
    background:
      radial-gradient(circle at 10% 0%, rgba(75, 212, 253, 0.12), transparent 42%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.985), rgba(247, 252, 255, 0.98)) !important;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      0 18px 44px rgba(40, 139, 192, 0.2),
      0 4px 12px rgba(18, 60, 87, 0.1) !important;
    color: #174a68;
    font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", Arial, sans-serif !important;
    backdrop-filter: blur(16px) saturate(135%);
  }

  .bsk-help-banner[data-display-mode="compact"] {
    border-radius: 14px !important;
  }

  .bsk-help-drag-pill {
    background: rgba(77, 135, 165, 0.36) !important;
  }

  .bsk-help-drag-strip:hover .bsk-help-drag-pill,
  .bsk-help-banner[data-dragging="true"] .bsk-help-drag-pill {
    background: #40c5f1 !important;
  }

  .bsk-help-header > img[alt="browser-skill"] {
    display: none !important;
  }

  .bsk-help-header::before {
    content: "";
    display: block;
    width: 27px;
    height: 27px;
    flex: 0 0 27px;
    box-sizing: border-box;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28' fill='none'%3E%3Cg transform='translate(0 1)'%3E%3Crect x='2.75' y='4' width='18.5' height='15.5' rx='2' fill='%2318a7ff' fill-opacity='.1' stroke='%2318a7ff' stroke-width='1.7'/%3E%3Cpath d='M3.4 8.25h17.2' stroke='%2318a7ff' stroke-width='1.7'/%3E%3Ccircle cx='5.75' cy='6.15' r='.75' fill='%2318a7ff'/%3E%3Ccircle cx='8.35' cy='6.15' r='.75' fill='%2318a7ff' fill-opacity='.65'/%3E%3Cpath d='m13.55 11.35 10.15 4.5-4.05 1.3 2.45 4.05-2.65 1.6-2.45-4.05-2.85 3.1-.6-10.5Z' fill='%23174a68' stroke='white' stroke-width='1.25' stroke-linejoin='round'/%3E%3C/g%3E%3C/svg%3E") center / 27px 27px no-repeat;
  }

  .bsk-help-title {
    color: #174a68 !important;
    font-weight: 700 !important;
  }

  .bsk-help-compact-title {
    color: #32627d !important;
    font-weight: 600 !important;
  }

  .bsk-help-prompt {
    color: #365d73 !important;
  }

  .bsk-help-collapse-toggle {
    border-radius: 8px !important;
    color: #51748a !important;
  }

  .bsk-help-collapse-toggle:hover {
    background: rgba(64, 197, 241, 0.1) !important;
    color: #149dd8 !important;
  }

  .bsk-help-note-input {
    border-color: rgba(64, 197, 241, 0.28) !important;
    border-radius: 10px !important;
    background: rgba(255, 255, 255, 0.76) !important;
    color: #174a68 !important;
    outline: none !important;
    transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
  }

  .bsk-help-note-input::placeholder {
    color: #8298a6 !important;
  }

  .bsk-help-note-input:focus {
    border-color: #40c5f1 !important;
    background: #fff !important;
    box-shadow: 0 0 0 3px rgba(64, 197, 241, 0.16) !important;
  }

  .bsk-help-btn-cancel {
    border: 1px solid rgba(64, 197, 241, 0.28) !important;
    border-radius: 10px !important;
    background: rgba(255, 255, 255, 0.72) !important;
    color: #42677d !important;
    transition: transform 140ms ease, border-color 140ms ease, background 140ms ease !important;
  }

  .bsk-help-btn-cancel:hover {
    border-color: #40c5f1 !important;
    background: #f3fbff !important;
    transform: translateY(-1px);
  }

  .bsk-help-btn-continue {
    border: 1px solid #149bdc !important;
    border-radius: 10px !important;
    background: linear-gradient(90deg, #40c5f1, #18a7ff) !important;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.3),
      0 6px 14px rgba(24, 167, 255, 0.22) !important;
    color: #fff !important;
    transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease !important;
  }

  .bsk-help-btn-continue:hover {
    filter: brightness(1.04);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.34),
      0 8px 18px rgba(24, 167, 255, 0.3) !important;
    transform: translateY(-1px);
  }

  .bsk-help-btn-cancel:active,
  .bsk-help-btn-continue:active {
    transform: translateY(0) scale(0.98);
  }

  .bsk-help-btn-cancel:focus-visible,
  .bsk-help-btn-continue:focus-visible,
  .bsk-help-collapse-toggle:focus-visible {
    outline: 2px solid #40c5f1 !important;
    outline-offset: 2px !important;
  }

  @media (prefers-color-scheme: dark) {
    .bsk-help-banner {
      border-color: rgba(114, 207, 255, 0.3) !important;
      background:
        radial-gradient(circle at 10% 0%, rgba(64, 197, 241, 0.12), transparent 42%),
        linear-gradient(180deg, rgba(30, 42, 54, 0.985), rgba(24, 35, 47, 0.985)) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 18px 44px rgba(0, 0, 0, 0.34) !important;
    }

    .bsk-help-header::before {
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28' fill='none'%3E%3Cg transform='translate(0 1)'%3E%3Crect x='2.75' y='4' width='18.5' height='15.5' rx='2' fill='%235ddcff' fill-opacity='.1' stroke='%235ddcff' stroke-width='1.7'/%3E%3Cpath d='M3.4 8.25h17.2' stroke='%235ddcff' stroke-width='1.7'/%3E%3Ccircle cx='5.75' cy='6.15' r='.75' fill='%235ddcff'/%3E%3Ccircle cx='8.35' cy='6.15' r='.75' fill='%235ddcff' fill-opacity='.65'/%3E%3Cpath d='m13.55 11.35 10.15 4.5-4.05 1.3 2.45 4.05-2.65 1.6-2.45-4.05-2.85 3.1-.6-10.5Z' fill='%23dff4ff' stroke='%23172430' stroke-width='1.25' stroke-linejoin='round'/%3E%3C/g%3E%3C/svg%3E") center / 27px 27px no-repeat;
    }

    .bsk-help-title,
    .bsk-help-prompt {
      color: #dff4ff !important;
    }

    .bsk-help-compact-title {
      color: #b9d8e8 !important;
    }

    .bsk-help-collapse-toggle {
      color: #a9c7d8 !important;
    }

    .bsk-help-note-input {
      border-color: rgba(114, 207, 255, 0.22) !important;
      background: rgba(10, 22, 32, 0.46) !important;
      color: #dff4ff !important;
    }

    .bsk-help-note-input:focus {
      background: rgba(10, 22, 32, 0.72) !important;
    }

    .bsk-help-btn-cancel {
      border-color: rgba(114, 207, 255, 0.24) !important;
      background: rgba(255, 255, 255, 0.04) !important;
      color: #c7e2ef !important;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    [data-slot="help-highlight"] {
      animation: none !important;
      box-shadow: 0 0 0 2px rgba(64, 197, 241, 0.8) !important;
    }
  }
`;

export function createScopedHelpI18n(language: string, profileName: string) {
  const displayName = profileName.trim() || "N.E.K.O";
  const scopedI18n = browserSkillI18n.cloneInstance({
    forkResourceStore: true,
    lng: language,
  });

  for (const locale of ["zh-CN", "en-US"] as const) {
    const baseBundle = browserSkillI18n.getResourceBundle(locale, "extension");
    if (baseBundle) {
      scopedI18n.addResourceBundle(locale, "extension", baseBundle, true, true);
    }
  }

  const copy = {
    "zh-CN": {
      title: `${displayName}需要你的帮助`,
      compactStatus: `${displayName}正在等待你完成此步骤`,
      noteLabel: `给${displayName}的备注（可选）`,
      notePlaceholder: `给${displayName}留言（可选）`,
      continue: "完成并交还控制权",
      cancel: "取消请求",
      collapse: "折叠",
      expand: "展开",
      dragHandle: "拖动以移动",
    },
    "en-US": {
      title: `${displayName} needs your help`,
      compactStatus: `${displayName} is waiting for you to finish this step`,
      noteLabel: `Optional note for ${displayName}`,
      notePlaceholder: `Add a note for ${displayName} (optional)`,
      continue: "Done, return control",
      cancel: "Cancel request",
      collapse: "Collapse",
      expand: "Expand",
      dragHandle: "Drag to move",
    },
  } as const;

  for (const [locale, values] of Object.entries(copy)) {
    for (const [key, value] of Object.entries(values)) {
      scopedI18n.addResource(locale, "extension", `helpRequest.${key}`, value);
    }
  }

  return scopedI18n;
}

export function HelpRequestOverlay({ request }: HelpRequestOverlayProps) {
  const { i18n } = useTranslation("extension");
  const profileName = useCurrentCatgirlProfileName(request !== null);
  const language = i18n.resolvedLanguage || i18n.language || "zh-CN";
  const scopedI18n = useMemo(
    () => createScopedHelpI18n(language, profileName),
    [language, profileName],
  );
  const localizedRequest = useMemo<HelpRequestData | null>(() => {
    if (!request) return null;
    return {
      ...request,
      title: request.title ? replaceAgentTerms(request.title, profileName) : undefined,
      prompt: replaceAgentTerms(request.prompt, profileName),
    };
  }, [request, profileName]);

  return (
    <I18nextProvider i18n={scopedI18n}>
      <style>{HELP_REQUEST_STYLES}</style>
      <UpstreamHelpRequestOverlay request={localizedRequest} />
    </I18nextProvider>
  );
}
