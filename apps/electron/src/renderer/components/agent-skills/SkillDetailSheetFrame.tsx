import * as React from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

interface SkillDetailSheetFrameProps {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Skill 详情的统一抽屉承载层。
 * 不同作用域只在正文能力和操作插槽上变化，保持相同的尺寸、可访问性和关闭行为。
 */
export function SkillDetailSheetFrame({
  open,
  title,
  onOpenChange,
  children,
}: SkillDetailSheetFrameProps): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        hideClose
        side="right"
        className="flex w-[62vw] min-w-[680px] max-w-[1100px] flex-col gap-0 p-0 sm:max-w-[1100px]"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
