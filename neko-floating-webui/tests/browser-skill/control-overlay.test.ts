import { describe, expect, it } from "vitest";
import { formatControlStatus } from "../../src/browser-skill/ui/ControlOverlay";
import { createScopedHelpI18n } from "../../src/browser-skill/ui/HelpRequestOverlay";
import { replaceAgentTerms } from "../../src/browser-skill/ui/profile-name";

describe("N.E.K.O BrowserSkill control status", () => {
  it("replaces Agent with the current catgirl profile name", () => {
    expect(formatControlStatus("Agent 正在控制", "  小夜  ")).toBe("小夜正在控制");
    expect(formatControlStatus("Agent controlling", "Nana")).toBe("Nana controlling");
  });

  it("never falls back to Agent while the profile name is unavailable", () => {
    expect(formatControlStatus("Agent 正在控制", "")).toBe("正在控制");
    expect(formatControlStatus("Agent controlling", "")).toBe("controlling");
  });

  it("uses the catgirl profile name throughout help request copy", () => {
    expect(replaceAgentTerms("Browser Agent 当前没有执行任务", "小夜")).toBe(
      "小夜当前没有执行任务",
    );
    expect(replaceAgentTerms("给 Agent 留言", "小夜")).toBe("给小夜留言");
    expect(replaceAgentTerms("Agent needs your help", "Nana")).toBe("Nana needs your help");
  });

  it("uses neutral N.E.K.O copy until the profile name is available", () => {
    expect(replaceAgentTerms("Browser Agent 当前没有执行任务", "")).toBe(
      "N.E.K.O当前没有执行任务",
    );
  });

  it("keeps complete localized actions in the scoped help translation bundle", () => {
    const zh = createScopedHelpI18n("zh-CN", "小夜");
    expect(zh.t("helpRequest.cancel", { ns: "extension" })).toBe("取消请求");
    expect(zh.t("helpRequest.continue", { ns: "extension" })).toBe("完成并交还控制权");
    expect(zh.t("helpRequest.notePlaceholder", { ns: "extension" })).toBe(
      "给小夜留言（可选）",
    );

    const en = createScopedHelpI18n("en-US", "Nana");
    expect(en.t("helpRequest.cancel", { ns: "extension" })).toBe("Cancel request");
    expect(en.t("helpRequest.continue", { ns: "extension" })).toBe("Done, return control");
  });
});
