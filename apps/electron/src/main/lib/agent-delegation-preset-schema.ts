type ZodModule = typeof import('zod')

/**
 * 委派目标预设引用。
 *
 * `workspaceSlug` 只对 `presetScope='workspace'` 有意义：内置/全局预设不属于任何
 * 工作区，携带 slug 会触发严格校验。模型常把 `preset_list` 返回的引用再补全成
 * 四字段对象，因此在描述里明确「照抄、不要自行补字段」，并在委派边界做归一化
 * （见 `agent-delegation-preset.ts` 的 `sanitizeDelegationReference`）。
 */
const PRESET_REFERENCE_DESCRIPTION = '新建且有多个可用预设时必填；按职责照抄 preset_list 返回的 presetReference，不要自行补字段'
const WORKSPACE_SLUG_DESCRIPTION = '仅 presetScope=workspace 时使用；内置/全局预设不要传该字段'

export function buildZodDelegationPresetReferenceSchema(z: ZodModule['z']) {
  const nonBlankString = z.string().trim().min(1)
  return z.object({
    presetId: nonBlankString,
    presetScope: z.enum(['builtin-meta', 'user-global', 'workspace']),
    workspaceSlug: nonBlankString.optional().describe(WORKSPACE_SLUG_DESCRIPTION),
    presetVersion: nonBlankString.optional(),
  }).optional().describe(PRESET_REFERENCE_DESCRIPTION)
}

export function buildTypeBoxDelegationPresetReferenceSchema(
  Type: typeof import('typebox').Type,
) {
  return Type.Optional(Type.Object({
    presetId: Type.String({ minLength: 1 }),
    presetScope: Type.Union([
      Type.Literal('builtin-meta'),
      Type.Literal('user-global'),
      Type.Literal('workspace'),
    ]),
    workspaceSlug: Type.Optional(Type.String({ minLength: 1, description: WORKSPACE_SLUG_DESCRIPTION })),
    presetVersion: Type.Optional(Type.String({ minLength: 1 })),
  }, { description: PRESET_REFERENCE_DESCRIPTION }))
}
