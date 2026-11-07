import * as React from "react";
import {
  Blocks,
  BriefcaseBusiness,
  Search,
  Plus,
  Upload,
  Download,
  Store,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@profer/ui/primitives/button";
import { agentSkillsCreateLabel } from "./agentSkillsToolbarLabels";

export type AgentSkillsToolbarDomain = "skills" | "marketplace" | "mcp" | "presets";
export type AgentSkillsToolbarScope = "workspace" | "global";

export interface AgentSkillsToolbarTab {
  value: AgentSkillsToolbarDomain;
  label: string;
  count?: number;
}

interface AgentSkillsToolbarProps {
  scope: AgentSkillsToolbarScope;
  domain: AgentSkillsToolbarDomain;
  tabs: AgentSkillsToolbarTab[];
  search: string;
  searchPlaceholder: string;
  onDomainChange: (domain: AgentSkillsToolbarDomain) => void;
  onSearchChange: (value: string) => void;
  onCreate?: () => void;
  onImport?: () => void;
  importLabel?: string;
  onSecondaryImport?: () => void;
  secondaryImportLabel?: string;
  onExport?: () => void;
  exportLabel?: string;
}

/** Agent 技能页唯一工具条：工作区与全局只替换数据和权限，不再各自维护布局。 */
export function AgentSkillsToolbar({
  scope,
  domain,
  tabs,
  search,
  searchPlaceholder,
  onDomainChange,
  onSearchChange,
  onCreate,
  onImport,
  importLabel = "导入",
  onSecondaryImport,
  secondaryImportLabel = "从文件导入",
  onExport,
  exportLabel = "导出",
}: AgentSkillsToolbarProps): React.ReactElement {
  return (
    <div className="titlebar-no-drag flex w-full min-w-0 flex-wrap items-center gap-2">
      <div
        className="relative flex h-8 items-stretch rounded-xl bg-muted p-0.5"
        role="tablist"
        aria-label={scope === "global" ? "全局能力领域" : "Agent 技能领域"}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={domain === tab.value}
            onClick={() => onDomainChange(tab.value)}
            className={cn(
              "relative flex min-w-[76px] items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors sm:min-w-[90px] sm:px-3",
              domain === tab.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.value === "skills" && <Blocks size={13} />}
            {tab.value === "marketplace" && <Store size={13} />}
            {tab.value === "presets" && <BriefcaseBusiness size={13} />}
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-2.5 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
        <Search size={13} className="shrink-0 text-foreground/40" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 focus:outline-none"
        />
      </div>

      {onCreate && (
        <Button
          type="button"
          size="sm"
          onClick={onCreate}
          className="h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium"
        >
          <Plus size={15} />
          {agentSkillsCreateLabel(scope, domain)}
        </Button>
      )}
      {onImport && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onImport}
          className="h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium"
        >
          <Upload size={15} />
          {importLabel}
        </Button>
      )}
      {onSecondaryImport && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSecondaryImport}
          className="h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium"
        >
          <Upload size={15} />
          {secondaryImportLabel}
        </Button>
      )}
      {onExport && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onExport}
          className="h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium"
        >
          <Download size={15} />
          {exportLabel}
        </Button>
      )}
    </div>
  );
}
