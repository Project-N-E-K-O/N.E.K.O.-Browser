import { describe, expect, it } from "vitest";
import {
  formatControlStatus,
  getControlOverlayPointerEvents,
} from "../../src/browser-skill/ui/ControlOverlay";
import { createScopedHelpI18n } from "../../src/browser-skill/ui/HelpRequestOverlay";
import { replaceAgentTerms } from "../../src/browser-skill/ui/profile-name";

describe("N.E.K.O BrowserSkill control status", () => {
  it("replaces Agent with the current catgirl profile name", () => {
    expect(formatControlStatus("Agent 正在控制", "  小夜  ")).toBe("小夜正在控制");
    expect(formatControlStatus("Agent controlling", "Nana")).toBe("Nana controlling");
  });

  it("recognizes every supported Agent status prefix", () => {
    expect(formatControlStatus("Browser Agent 当前没有执行任务", "小夜")).toBe(
      "小夜当前没有执行任务",
    );
    expect(formatControlStatus("AI Agent：正在控制", "小夜")).toBe("小夜：正在控制");
    expect(formatControlStatus("Agent正在控制", "小夜")).toBe("小夜正在控制");
    expect(formatControlStatus("BrowserAgent 当前没有执行任务", "小夜")).toBe(
      "小夜当前没有执行任务",
    );
  });

  it("recognizes Japanese and Korean Agent status prefixes", () => {
    expect(formatControlStatus("Agentが操作中", "小夜")).toBe("小夜が操作中");
    expect(formatControlStatus("Agent カタカナで操作中", "小夜")).toBe(
      "小夜カタカナで操作中",
    );
    expect(formatControlStatus("Agent 가 제어 중", "小夜")).toBe("小夜가 제어 중");
  });

  it("recognizes hyphen and dash Agent status separators", () => {
    expect(formatControlStatus("Agent-正在控制", "小夜")).toBe("小夜-正在控制");
    expect(formatControlStatus("Agent–正在控制", "小夜")).toBe("小夜–正在控制");
    expect(formatControlStatus("Agent—正在控制", "小夜")).toBe("小夜—正在控制");
    expect(formatControlStatus("Agent—正在控制", "")).toBe("正在控制");
  });

  it("never falls back to Agent while the profile name is unavailable", () => {
    expect(formatControlStatus("Agent 正在控制", "")).toBe("正在控制");
    expect(formatControlStatus("Agent controlling", "")).toBe("controlling");
    expect(formatControlStatus("Agent：正在控制", "")).toBe("正在控制");
    expect(formatControlStatus("Browser Agent当前没有执行任务", "")).toBe("当前没有执行任务");
  });

  it("treats replacement-string metacharacters in profile names literally", () => {
    expect(replaceAgentTerms("Agent 正在控制", "$&/喵")).toBe("$&/喵正在控制");
    expect(formatControlStatus("AI Agent 正在控制", "$&/喵")).toBe("$&/喵正在控制");
  });

  it("lets automation bypass the pill while keeping normal mode interactive", () => {
    expect(getControlOverlayPointerEvents(true)).toBe("none");
    expect(getControlOverlayPointerEvents(false)).toBe("auto");
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
