/**
 * 路由卡片表单转换的契约。
 *
 * 关键点：① 表单不碰名称与描述，也不提供写触发词的地方——「什么时候用」只写在描述里；
 * ② 卡片里的旧词表（triggers）保存时必须原样保留，不能被界面静默删掉；
 * ③ 依赖留空必须变成「删除字段」而不是写空数组。
 */
import { describe, expect, test } from 'bun:test'
import { cardFormFromManifest, cardPatchFromForm, isSkillCardFormEmpty, joinPhrases, splitPhrases, EMPTY_SKILL_CARD_FORM } from './skillCardForm'

describe('路由卡片表单：短语解析', () => {
  test('按中英文分隔符切分，去空白去重并保序', () => {
    expect(splitPhrases('柱状图，折线图、饼图; 柱状图\n 流程图 ')).toEqual(['柱状图', '折线图', '饼图', '流程图'])
    expect(splitPhrases('   ')).toEqual([])
    expect(splitPhrases('a,,,b')).toEqual(['a', 'b'])
  })

  test('回填时用顿号连接，空值给空串', () => {
    expect(joinPhrases(['柱状图', '折线图'])).toBe('柱状图、折线图')
    expect(joinPhrases(undefined)).toBe('')
  })
})

describe('路由卡片表单：清单 ⇄ 表单', () => {
  test('从清单回填表单：只取依赖与触发方式，不回填词表也不丢弃它', () => {
    const form = cardFormFromManifest({
      schemaVersion: 1,
      triggers: { keywords: ['柱状图'], excludeKeywords: ['不要图表'] },
      dependencies: { toolGroups: ['preview'], tools: ['present_visualization'] },
      policy: { implicit: false },
    })
    expect(form).toEqual({ toolGroups: ['preview'], tools: 'present_visualization', explicitOnly: true })
    // 保存时不得把 triggers 当成「清空」提交，否则旧词表会被界面抹掉。
    expect(cardPatchFromForm(form)).not.toHaveProperty('triggers')
  })

  test('没有卡片时给出空表单', () => {
    expect(cardFormFromManifest(undefined)).toEqual({ ...EMPTY_SKILL_CARD_FORM })
    expect(isSkillCardFormEmpty(EMPTY_SKILL_CARD_FORM)).toBe(true)
  })

  test('表单转补丁：有依赖就写，空依赖变成删除（null）', () => {
    expect(cardPatchFromForm({ toolGroups: ['preview'], tools: '', explicitOnly: true })).toEqual({
      dependencies: { toolGroups: ['preview'], tools: [] },
      policy: { implicit: false },
    })
    // 全空 = 删除依赖并取消显式引用；写入器随后会删掉空卡片，回到无卡片回退路径。
    expect(cardPatchFromForm(EMPTY_SKILL_CARD_FORM)).toEqual({ dependencies: null, policy: { implicit: null } })
  })

  test('空表单判定只看卡片自己管的东西', () => {
    expect(isSkillCardFormEmpty({ ...EMPTY_SKILL_CARD_FORM, toolGroups: ['preview'] })).toBe(false)
    expect(isSkillCardFormEmpty({ ...EMPTY_SKILL_CARD_FORM, explicitOnly: true })).toBe(false)
  })
})
