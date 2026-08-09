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

export function replaceAgentTerms(value: string, profileName: string): string {
  const replacement = profileName.trim() || "N.E.K.O";
  const replaced = value.replace(/\b(?:Browser\s+Agent|AI\s+Agent|Agent)\b/gi, replacement);
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
