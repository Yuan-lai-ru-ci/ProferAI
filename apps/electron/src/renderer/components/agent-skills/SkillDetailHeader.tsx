import * as React from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SkillDetailHeaderProps {
  title: string;
  name: string;
  slug: string;
  version?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  onBack: () => void;
}

/** 工作区与全局 Skill 详情共用的标题和操作承载。 */
export function SkillDetailHeader({
  title,
  name,
  slug,
  version,
  badge,
  actions,
  onBack,
}: SkillDetailHeaderProps): React.ReactElement {
  return (
    <div className="shrink-0 border-b border-border/60 px-5 pb-4 pt-5">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          type="button"
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
      </div>
      <div className="mt-4 flex items-start gap-3">
        <div className="shrink-0 rounded-xl bg-amber-500/12 p-2 text-amber-500 shadow-sm">
          <Sparkles size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {name}
            </h3>
            {version && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                v{version}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{slug}</span>
            {badge}
          </div>
        </div>
      </div>
      {actions && (
        <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
