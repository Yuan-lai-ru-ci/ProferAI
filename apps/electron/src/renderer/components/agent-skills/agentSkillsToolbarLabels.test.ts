import { describe, expect, test } from "bun:test";
import { agentSkillsCreateLabel } from "./agentSkillsToolbarLabels";

describe("agentSkillsCreateLabel", () => {
  test("工作区 MCP 页不显示 Skill 文案", () => {
    expect(agentSkillsCreateLabel("workspace", "mcp")).toBe("新建 MCP 服务器");
  });

  test("全局 MCP 页不显示 Skill 文案", () => {
    expect(agentSkillsCreateLabel("global", "mcp")).toBe("新建全局 MCP 服务器");
  });

  test("Skills 页保持原文案", () => {
    expect(agentSkillsCreateLabel("workspace", "skills")).toBe("新建 Skill");
    expect(agentSkillsCreateLabel("global", "skills")).toBe("新建全局 Skill");
  });

  test("预设页保持原文案", () => {
    expect(agentSkillsCreateLabel("workspace", "presets")).toBe("新建预设");
    expect(agentSkillsCreateLabel("global", "presets")).toBe("新建全局预设");
  });

  test("每个领域的工作区与全局文案互不相同且都带作用域前缀", () => {
    const domains = ["skills", "marketplace", "mcp", "presets"] as const;
    for (const domain of domains) {
      const workspaceLabel = agentSkillsCreateLabel("workspace", domain);
      const globalLabel = agentSkillsCreateLabel("global", domain);
      expect(globalLabel).toBe(`新建全局${workspaceLabel.slice("新建".length)}`);
      expect(workspaceLabel.includes("Skill")).toBe(domain !== "mcp" && domain !== "presets");
    }
  });
});
