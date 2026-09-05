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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type AgentSkillsToolbarDomain =
  "skills" | "marketplace" | "mcp" | "memory" | "presets";
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
  onlyEffective?: boolean;
  sortMode?: string;
  sortOptions?: Array<{ value: string; label: string }>;
  onDomainChange: (domain: AgentSkillsToolbarDomain) => void;
  onSearchChange: (value: string) => void;
  onOnlyEffectiveChange?: (value: boolean) => void;
  onSortChange?: (value: string) => void;
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
  onlyEffective = false,
  sortMode,
  sortOptions,
  onDomainChange,
  onSearchChange,
  onOnlyEffectiveChange,
  onSortChange,
  onCreate,
  onImport,
  importLabel = "导入",
  onSecondaryImport,
  secondaryImportLabel = "从文件导入",
  onExport,
  exportLabel = "导出",
}: AgentSkillsToolbarProps): React.ReactElement {
  return (
    <div className="titlebar-no-drag mx-auto flex w-full max-w-6xl shrink-0 flex-wrap items-center gap-2 px-4 pb-4 sm:px-6 lg:px-8">
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

      <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 transition-colors focus-within:border-primary/40">
        <Search size={14} className="shrink-0 text-foreground/40" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 focus:outline-none"
        />
      </div>

      {onOnlyEffectiveChange && (
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-2.5 text-xs text-foreground/70">
          <Switch
            checked={onlyEffective}
            onCheckedChange={onOnlyEffectiveChange!}
            className="scale-75"
          />
          只看生效的
        </label>
      )}
      {sortOptions && sortMode && onSortChange && (
        <select
          value={sortMode}
          onChange={(event) => onSortChange(event.target.value)}
          className="h-8 rounded-lg border border-border/60 bg-content-area px-2 text-xs text-foreground/70 outline-none"
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      {onCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <Plus size={14} />
          {scope === "global"
            ? `新建全局${domain === "presets" ? "预设" : " Skill"}`
            : `新建${domain === "presets" ? "预设" : " Skill"}`}
        </button>
      )}
      {onImport && (
        <button
          type="button"
          onClick={onImport}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-3 text-[13px] font-medium text-foreground/80 shadow-sm transition-colors hover:bg-foreground/[0.04]"
        >
          <Upload size={14} />
          {importLabel}
        </button>
      )}
      {onSecondaryImport && (
        <button
          type="button"
          onClick={onSecondaryImport}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-3 text-[13px] font-medium text-foreground/80 shadow-sm transition-colors hover:bg-foreground/[0.04]"
        >
          <Upload size={14} />
          {secondaryImportLabel}
        </button>
      )}
      {onExport && (
        <button
          type="button"
          onClick={onExport}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-3 text-[13px] font-medium text-foreground/80 shadow-sm transition-colors hover:bg-foreground/[0.04]"
        >
          <Download size={14} />
          {exportLabel}
        </button>
      )}
    </div>
  );
}
