import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptBrowserSkillVomCapture,
  NEKO_OBSERVATION_IGNORE_ATTRIBUTE,
} from "./vom-adapter";

describe("BrowserSkill VOM adapter", () => {
  it("excludes N.E.K.O in both DOMSnapshot and fallback capture paths", () => {
    const upstream = readFileSync(
      resolve(
        import.meta.dirname,
        "../../vendor/browser-skill/apps/extension/src/tools/vom/capture.ts",
      ),
      "utf8",
    );
    const adapted = adaptBrowserSkillVomCapture(upstream);

    expect(adapted).toContain(`attrNames.includes("${NEKO_OBSERVATION_IGNORE_ATTRIBUTE}")`);
    expect(adapted).toContain('cdp.send<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll"');
    expect(adapted).toContain(`OVERLAY_HOST_SELECTOR + ", [${NEKO_OBSERVATION_IGNORE_ATTRIBUTE}]"`);
    expect(adapted).toContain("for (const nodeId of found.nodeIds ?? [])");
  });
});
