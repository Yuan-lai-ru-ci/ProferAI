import * as React from "react";
import { MasterSkillsTab } from "./MasterSkillsTab";
import { AgentPresetSettings } from "./AgentPresetSettings";

type GlobalCapabilityTab = "skills" | "presets";

interface GlobalCapabilitiesViewProps {
  initialTab?: GlobalCapabilityTab;
  workspaceSlug?: string;
  search?: string;
  createSkillRequestToken?: number;
  importSkillRequestToken?: number;
  createPresetRequestToken?: number;
}

/** 全局内容容器：工具条由父页面统一渲染，子领域只负责列表、编辑和详情。 */
export function GlobalCapabilitiesView({
  initialTab = "skills",
  workspaceSlug,
  search = "",
  createSkillRequestToken = 0,
  importSkillRequestToken = 0,
  createPresetRequestToken = 0,
}: GlobalCapabilitiesViewProps): React.ReactElement {
  return (
    <section aria-label="全局配置" className="flex flex-col gap-5">
      {initialTab === "skills" ? (
        <MasterSkillsTab
          globalMode
          workspaceSlug={workspaceSlug}
          search={search}
          onChanged={() => undefined}
          hideToolbar
          createRequestToken={createSkillRequestToken}
          importRequestToken={importSkillRequestToken}
        />
      ) : (
        <AgentPresetSettings
          globalMode
          workspaceSlug={workspaceSlug}
          search={search}
          hideToolbar
          createRequestToken={createPresetRequestToken}
        />
      )}
    </section>
  );
}
