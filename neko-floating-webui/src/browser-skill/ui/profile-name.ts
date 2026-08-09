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
const AGENT_STATUS_PREFIX_PATTERN = new RegExp(
  String.raw`^${AGENT_TERM_SOURCE}(?=$|\s|[:：，。！？、]|[\u3400-\u9fff])`,
  "i",
);

export function hasAgentStatusPrefix(value: string): boolean {
  return AGENT_STATUS_PREFIX_PATTERN.test(value);
}

export function stripAgentStatusPrefix(value: string): string {
  return value
    .replace(AGENT_STATUS_PREFIX_PATTERN, "")
    .replace(/^[\s:：，。！？、—–-]+/u, "")
    .trim();
}

export function replaceAgentTerms(value: string, profileName: string): string {
  const replacement = profileName.trim() || "N.E.K.O";
  const replaced = value.replace(AGENT_TERM_PATTERN, () => replacement);
  if (!/[\u3400-\u9fff]/u.test(replaced)) {
    return replaced;
  }

  const escapedReplacement = replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutLeadingCjkSpace = replaced.replace(
    new RegExp(`([\\u3400-\\u9fff])\\s+(${escapedReplacement})`, "gu"),
    "$1$2",
  );
  return withoutLeadingCjkSpace.replace(
    new RegExp(`(${escapedReplacement})\\s+(?=[\\u3400-\\u9fff])`, "gu"),
    "$1",
  );
}
