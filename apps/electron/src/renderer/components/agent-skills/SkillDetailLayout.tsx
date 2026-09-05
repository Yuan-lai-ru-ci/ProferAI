import * as React from "react";
import { SkillDetailHeader } from "./SkillDetailHeader";

interface SkillDetailLayoutProps {
  title: string;
  name: string;
  slug: string;
  version?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  onBack: () => void;
  /**
   * 作用域专属的范围管理或内容标签。它位于统一头部之下、滚动正文之前，
   * 保证工作区与全局详情拥有相同的结构层级。
   */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Skill 详情正文的统一布局契约。
 *
 * 作用域差异只能通过 header actions、toolbar 和正文 children 三个插槽表达；
 * 抽屉尺寸、标题、元数据/内容正文的纵向结构均由该组件统一承载。
 */
export function SkillDetailLayout({
  title,
  name,
  slug,
  version,
  badge,
  actions,
  onBack,
  toolbar,
  children,
}: SkillDetailLayoutProps): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SkillDetailHeader
        title={title}
        name={name}
        slug={slug}
        version={version}
        badge={badge}
        actions={actions}
        onBack={onBack}
      />
      {toolbar}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
