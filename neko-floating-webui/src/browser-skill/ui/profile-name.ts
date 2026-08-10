import { useEffect, useState } from "react";

interface CurrentCatgirlResponse {
  profileName?: unknown;
}

export function useCurrentCatgirlProfileName(active: boolean): string {
  const [profileName, setProfileName] = useState("");

  useEffect(() => {
    if (!active) {
      setProfileName("");
      return;
    }

    let mounted = true;
    chrome.runtime
      .sendMessage({ type: "NEKO_GET_CURRENT_CATGIRL" })
      .then((response: CurrentCatgirlResponse | undefined) => {
        if (!mounted) return;
        const nextName = typeof response?.profileName === "string"
          ? response.profileName.trim().slice(0, 128)
          : "";
        setProfileName(nextName);
      })
      .catch(() => {
        if (mounted) setProfileName("");
      });

    return () => {
      mounted = false;
    };
  }, [active]);

  return profileName;
}

const AGENT_TERM_SOURCE = String.raw`(?:Browser\s*Agent|AI\s*Agent|Agent)`;
const AGENT_TERM_PATTERN = new RegExp(String.raw`\b${AGENT_TERM_SOURCE}\b`, "gi");
const EAST_ASIAN_CHAR_SOURCE = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const AGENT_SEPARATOR_SOURCE = String.raw`\s:：，。！？、\u002d\u2013\u2014`;
const EAST_ASIAN_CHAR_PATTERN = new RegExp(`[${EAST_ASIAN_CHAR_SOURCE}]`, "u");
const AGENT_STATUS_PREFIX_PATTERN = new RegExp(
  String.raw`^${AGENT_TERM_SOURCE}(?=$|[${AGENT_SEPARATOR_SOURCE}]|[${EAST_ASIAN_CHAR_SOURCE}])`,
  "iu",
);
const LEADING_AGENT_SEPARATOR_PATTERN = new RegExp(
  String.raw`^[${AGENT_SEPARATOR_SOURCE}]+`,
  "u",
);

export function hasAgentStatusPrefix(value: string): boolean {
  return AGENT_STATUS_PREFIX_PATTERN.test(value);
}

export function stripAgentStatusPrefix(value: string): string {
  return value
    .replace(AGENT_STATUS_PREFIX_PATTERN, "")
    .replace(LEADING_AGENT_SEPARATOR_PATTERN, "")
    .trim();
}

export function replaceAgentTerms(value: string, profileName: string): string {
  const replacement = profileName.trim() || "N.E.K.O";
  const replaced = value.replace(AGENT_TERM_PATTERN, () => replacement);
  if (!EAST_ASIAN_CHAR_PATTERN.test(replaced)) {
    return replaced;
  }

  const escapedReplacement = replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutLeadingEastAsianSpace = replaced.replace(
    new RegExp(`([${EAST_ASIAN_CHAR_SOURCE}])\\s+(${escapedReplacement})`, "gu"),
    "$1$2",
  );
  return withoutLeadingEastAsianSpace.replace(
    new RegExp(`(${escapedReplacement})\\s+(?=[${EAST_ASIAN_CHAR_SOURCE}])`, "gu"),
    "$1",
  );
}
