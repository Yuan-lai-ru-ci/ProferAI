import type {
  AgentSkillsToolbarDomain,
  AgentSkillsToolbarScope,
} from "./AgentSkillsToolbar";

/**
 * 各领域“新建”按钮的名词部分。
 * 前导空格只用于中文与拉丁词之间的排版间隔（如「新建 MCP 服务器」）。
 */
const CREATE_NOUN: Record<AgentSkillsToolbarDomain, string> = {
  skills: " Skill",
  marketplace: " Skill",
  mcp: " MCP 服务器",
  presets: "预设",
};

/** 唯一决定新建按钮文案的地方：领域变化必须同步到按钮文字，避免 MCP 页显示“新建 Skill”。 */
export function agentSkillsCreateLabel(
  scope: AgentSkillsToolbarScope,
  domain: AgentSkillsToolbarDomain,
): string {
  return `${scope === "global" ? "新建全局" : "新建"}${CREATE_NOUN[domain]}`;
}
