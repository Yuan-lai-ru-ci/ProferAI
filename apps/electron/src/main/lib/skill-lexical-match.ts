/**
 * 字符 n-gram 召回层：**只在确定性关键词零命中时兜底**。
 *
 * 做法移植自 Codex `codex-rs/ext/skills/src/dynamic_skill_selector/character_ngram.rs`：
 * 文本切成 2–5 字符的 n-gram，按 `IDF × 字段权重` 累加打分，命中 gram 数不够就不推荐，
 * 字段权重 name > description（Codex 用 name/short_description/description = 8/4/1）。
 *
 * 为什么不用词级 BM25：中文没有空格，按空白分词的 BM25 在中文描述上等于没分词。
 * 字符 n-gram 对中英混排都成立，也不需要额外词典——这也正是 Codex 为无空格语言另做一套
 * 字符选择器的原因。字符 n-gram 只能识别"用词重叠"，识别不了"意图"；所以它只是关键词的补集，
 * 不是替代品，且必须过下面三道闸：最短消息、最少命中 gram 数、相对第二名的领先幅度。
 */
export interface LexicalSkillDocument {
  slug: string
  name: string
  description: string
}

export interface LexicalSkillMatch {
  slug: string
  score: number
  matchedGrams: number
}

/** [name, description]：名字命中远比描述命中值钱。 */
const FIELD_WEIGHTS = [8, 1] as const
const MIN_GRAM_CHARS = 2
const MAX_GRAM_CHARS = 5
const MAX_QUERY_GRAMS = 512
const MAX_QUERY_CHARS = 4 * 1024
const MAX_DOCUMENT_CHARS = 4 * 1024
/** 少于这个长度不猜（"改一下代码""好的" 这类交给关键词）。 */
const MIN_QUERY_CHARS = 8
/**
 * 至少命中这么多个查询 gram（查询本身 gram 更少时按查询 gram 数）。
 *
 * 标定依据（用真实 Skill 目录实测，见交付记录）：本层与 Codex 的选择器有一处本质差别——
 * 它只产出候选排序，供模型再判断；我们一命中就直接注入正文，误差代价高得多。
 * 实测里噪音（“这 5 个测试为什么失败”“为什么这里会死循环”= 3 gram；“帮我在飞书里建一个日程”
 * 错召回到 tool-builder = 4 gram）与真实命中（量级差一截：13–16 gram）分得很开，
 * 而“意图没被文档覆盖”的漏召回（2–3 gram）本来就不该靠放宽阈值去捞——那只会捞进同量级的噪音。
 *
 * 刻意**不用绝对分数下限**：分数 = Σ IDF × 权重，而 IDF 随目录规模变化（同一段文本在 2 个 Skill
 * 的目录里总分只有 17 个 Skill 目录的三分之一），写死阈值不可移植。可移植的信号是
 * “命中了多少个查询 gram”与“领先第二名多少倍”。
 */
const MIN_MATCHED_GRAMS = 6
/** 第一名必须比第二名高这么多倍，否则视为歧义，宁可不推荐。 */
const MIN_LEAD_RATIO = 1.5

export function scoreSkillsLexically(
  query: string,
  documents: readonly LexicalSkillDocument[],
): LexicalSkillMatch[] {
  const terms = normalizeTerms(query.trim().slice(0, MAX_QUERY_CHARS))
  if (terms.join('').length < MIN_QUERY_CHARS) return []
  const queryGrams = gramsOfTerms(terms)
  if (!queryGrams.length) return []

  const prepared = documents.map(document => ({
    slug: document.slug,
    name: document.name,
    fields: [documentGrams(document.name), documentGrams(document.description)],
  }))
  const frequencies = new Map<string, number>()
  for (const document of prepared) {
    for (const gram of new Set([...document.fields[0]!, ...document.fields[1]!])) {
      frequencies.set(gram, (frequencies.get(gram) ?? 0) + 1)
    }
  }

  const total = prepared.length
  const matches: LexicalSkillMatch[] = []
  for (const document of prepared) {
    let score = 0
    let matchedGrams = 0
    for (const gram of queryGrams) {
      const frequency = frequencies.get(gram) ?? 0
      if (!frequency) continue
      let weight = 0
      document.fields.forEach((field, index) => { if (field.has(gram)) weight += FIELD_WEIGHTS[index]! })
      if (!weight) continue
      score += Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)) * weight
      matchedGrams += 1
    }
    if (score > 0) matches.push({ slug: document.slug, score, matchedGrams })
  }
  return matches.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
}

/** 只取唯一赢家；命中 gram 数或领先幅度任一项不达标就返回 undefined（不猜比猜错便宜）。 */
export function selectLexicalFallback(
  query: string,
  documents: readonly LexicalSkillDocument[],
): LexicalSkillMatch | undefined {
  const matches = scoreSkillsLexically(query, documents)
  const best = matches[0]
  if (!best) return undefined
  const queryGrams = gramsOfTerms(normalizeTerms(query.trim().slice(0, MAX_QUERY_CHARS)))
  if (best.matchedGrams < Math.min(queryGrams.length, MIN_MATCHED_GRAMS)) return undefined
  const runnerUp = matches[1]
  if (runnerUp && best.score < runnerUp.score * MIN_LEAD_RATIO) return undefined
  return best
}

/** 字母与数字保持（CJK 表意文字在 Unicode 分类里属于 Letter，因此中文会成为一个长 term，正是 n-gram 生效的前提），其余当分隔符。 */
function normalizeTerms(value: string): string[] {
  return value.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function gramsOfTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const grams: string[] = []
  for (const term of terms) {
    const characters = [...term]
    // 与 Codex 一致：足够长的 ASCII 词从 3-gram 起，避免 "the/a" 之类噪声；CJK 从 2-gram 起。
    const minimumSize = /^[\x20-\x7E]+$/.test(term) && characters.length > MIN_GRAM_CHARS ? MIN_GRAM_CHARS + 1 : MIN_GRAM_CHARS
    for (let size = minimumSize; size <= Math.min(MAX_GRAM_CHARS, characters.length); size += 1) {
      for (let start = 0; start + size <= characters.length; start += 1) {
        const gram = characters.slice(start, start + size).join('')
        if (seen.has(gram)) continue
        seen.add(gram)
        if (grams.length >= MAX_QUERY_GRAMS) return grams
        grams.push(gram)
      }
    }
  }
  return grams
}

function documentGrams(value: string): Set<string> {
  return new Set(gramsOfTerms(normalizeTerms(value.slice(0, MAX_DOCUMENT_CHARS))))
}
