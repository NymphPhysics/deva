import { streamChat } from '../providers'
import type { ResolvedModel } from './model-resolve'
import {
  resolveDefaultModel,
  resolveModelRefOrNull
} from './model-resolve'
import { getConfig } from './config'
import { TITLE_MAX, save as saveSession, getSession, type StoredSession, type TitleAuto } from './chat-store'
import { buildTranscript, isAutoNudge, isCompactionSummary, isTaskNotification } from './compaction'
import { publishSessionsChanged } from './chat-bus'
import { isEn } from '../locale'
import { clampEffort, effortRequest } from '../../shared/effort'

/**
 * 对话标题自动校正（主进程）。
 *
 * 解决什么：标题此前只在首条用户消息落地时由 deriveTitle 截断定死（见 chat-store.ts），而首条消息
 * 往往只是「帮我看看这个报错」或贴一段链接——真正要解决什么，得往下聊才清楚。等聊明白了，标题已经
 * 对不上，历史对话就找不回来了（对齐 Codex Title Updater 的出发点）。
 *
 * 做法：每轮结束（runTurn 的 finally）按节奏请一次**便宜的**模型判断「这个标题还配不配得上这段对话」，
 * 明显失准才改，准就留着——不为换措辞而改名。判完即走，**不参与、也绝不影响本轮回复**。
 *
 * 节奏：第 1 轮后先校一次，此后每 4 轮一次（第 5、9、13… 轮）；每次成功改名后同样至少隔 4 轮再判，
 * 避免同一件事换个说法就来回改。检查点由 StoredSession.titleAuto.turns 独立计数得出，**不数消息**：
 * 压缩会抹掉早期轮，数出来会倒退。
 *
 * 手改保护：应用内改标题只有 chat:rename-session 一条通路，来源完全可知，故 handren 过的会话直接
 * 永久退出自动校正（keep 策略）；标题被清空 = 交还给自动。另有一道通用防线：我们只认自己写进去的
 * 标题（titleAuto.applied），当前标题与之不符即视为被别处改过，同样停手。
 *
 * 与压缩一致的取舍：只采信「干净收尾 + 能解析 + confidence 达标」的那一次判断，其余一律当作没发生，
 * 下一轮自然会再来——绝不因为一次失败的检查就去猜标题。
 */

// ── 配置（config.json 顶层 title 段，明文可手改）────────────────────────────

/** 默认检查间隔（每完成这么多轮检查一次，按用户的设定：首轮后每 4 轮一次）。 */
const DEFAULT_EVERY = 4
/** 默认 confidence 下限：模型自评不到这个把握就不改名。 */
const DEFAULT_MIN_CONFIDENCE = 0.9
/** 同一会话连续失败这么多次就停手（防刷日志、防无谓消耗），成功一次即清零。 */
const MAX_CONSECUTIVE_FAILURES = 3
/** 单次判断请求的总时长上限：只兜住「吐字却永不收尾」的跑飞流，正常几秒就回。 */
const CHECK_TIMEOUT_MS = 60_000
/** 判断请求的输出上限：正文只是一小段 JSON，留足余量给会先写思考的模型。 */
const CHECK_MAX_TOKENS = 1024
/** 取样：最近多少条消息、总字符上限（标题判断看个大概即可，不必整段转录）。 */
const DIGEST_MESSAGES = 12
const DIGEST_CHARS = 2500
/** 首条真实请求的取样字数。 */
const FIRST_REQUEST_CHARS = 300

export interface TitleCfg {
  /** 总开关。 */
  enabled: boolean
  /** 检查间隔（轮）。首轮结束后总会先检查一次，此后每这么多轮一次。 */
  every: number
  /** 执行改名的 confidence 下限（0–1）。 */
  minConfidence: number
  /** 判断请求用的模型引用 `providerId:modelId`；空 = 跟随本对话当前模型 → 全局默认。 */
  model: string
  /** 标题语言：auto = 跟随界面语言。 */
  lang: 'auto' | 'zh' | 'en'
}

const DEFAULTS: TitleCfg = {
  enabled: true,
  every: DEFAULT_EVERY,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  model: '',
  lang: 'auto'
}

/** 从 config.json 的 `title` 段读配置（明文可手改即设置面），非法值回退默认。 */
export function titleConfig(): TitleCfg {
  const raw = (getConfig().title ?? {}) as Partial<TitleCfg>
  const every = typeof raw.every === 'number' ? Math.round(raw.every) : DEFAULT_EVERY
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    // 间隔至少 1：写成 0 / 负数等于每轮都查，与「每过几轮一次」的本意相反。
    every: every >= 1 ? Math.min(every, 100) : DEFAULT_EVERY,
    minConfidence:
      typeof raw.minConfidence === 'number' && raw.minConfidence > 0 && raw.minConfidence <= 1
        ? raw.minConfidence
        : DEFAULT_MIN_CONFIDENCE,
    model: typeof raw.model === 'string' ? raw.model.trim() : DEFAULTS.model,
    lang: raw.lang === 'zh' || raw.lang === 'en' ? raw.lang : DEFAULTS.lang
  }
}

// ── 状态与节奏 ─────────────────────────────────────────────────────────────

/**
 * 本轮是否该做检查。轮数在每个回合结束时由 chat.ts 累加，故这里按「当前累计轮数」判定。
 * 节奏 = 首轮一次 + 此后每 `every` 轮一次的固定网格；改名后额外压住 `every` 轮，
 * 避免同一件事换个说法就让标题来回变（压过之后仍回到网格上，不会变成每轮都查）。
 */
function isDue(a: TitleAuto, cfg: TitleCfg): boolean {
  const t = a.turns
  // 首轮结束后先校一次：首条消息最容易起出含糊标题，越早纠正越有用。
  if (t === 1) return true
  if (t < 1) return false
  // 固定在「第 1 + k*every 轮」这条网格上（第 5、9、13… 轮）。
  if ((t - 1) % cfg.every !== 0) return false
  // 刚改过名：再压住 `every` 轮（首轮改名 → 第 5 轮才复查，而不是第 2 轮）。
  if (a.renamedAt != null && t - a.renamedAt < cfg.every) return false
  return true
}

/** 该会话是否允许自动改标题：手改过（keep 策略）、或标题被别处改过，一律停手。 */
function isManageable(session: StoredSession, a: TitleAuto): boolean {
  if (a.manual) return false
  // applied 只在「我们自己写过标题」后才有：与当前标题不符 = 期间被别处改过，视为用户接管。
  if (a.applied !== undefined && a.applied !== session.title) return false
  return true
}

/** 用户在应用内手改了标题（chat:rename-session）。标题被清空 = 恢复自动标题 = 交还给自动校正。 */
export function markTitleManual(session: StoredSession, manual: boolean): void {
  const a = session.titleAuto
  if (manual) {
    session.titleAuto = { turns: a?.turns ?? 0, ...a, manual: true }
    return
  }
  // 恢复自动标题：清掉手改标记与「我们写过的标题」，让首轮派生的标题重新可被校正。
  if (!a) return
  session.titleAuto = { turns: a.turns }
}

/** 历史被清空（chat:reset）后，轮计数与「已校正过」全部失效，归零重来。 */
export function resetTitleAuto(session: StoredSession): void {
  session.titleAuto = undefined
}

// ── 轮末入口 ───────────────────────────────────────────────────────────────

/** 正在跑的检查（防止用户秒回时上一检查还没结束就叠跑）。 */
const running = new Set<string>()
/** 连续失败计数（键 = 会话 id），成功一次即清零。 */
const failures = new Map<string, number>()

export interface AutoTitleOpts {
  /** 本轮是正常结束还是出错 / 被中止——只有正常结束的轮才值得拿来判标题。 */
  endReason: string
  /** 本轮结束后马上还要接着下一轮（插入消息 / 成员交差）：等那一轮结束再判。 */
  continues: boolean
  /** 定时任务发起（无人值守）：其对话标题就是任务标题，不该被改写。 */
  scheduled?: boolean
}

/**
 * 轮末钩子：判节奏、请模型复核标题。**永不抛错**，也绝不阻塞、不影响本轮回复。
 * 调用方只管 `void maybeAutoTitle(...)`，失败只留一行日志。
 * 轮数已由调用方在落盘前累加（见 chat.ts 的 runTurn finally），这里只读不写。
 */
export async function maybeAutoTitle(session: StoredSession, opts: AutoTitleOpts): Promise<void> {
  try {
    const cfg = titleConfig()
    const a: TitleAuto = session.titleAuto ?? { turns: 0 }
    if (a.turns <= 0) return
    if (!cfg.enabled) return
    // 出错 / 被中止的轮：手里是半截对话，不足以判标题。
    if (opts.endReason === 'aborted' || opts.endReason === 'error') return
    // 马上要接着下一轮：等那一轮结束一起判，免得同一件事判两次。
    if (opts.continues) return
    // 成员会话的标题由主对话的成员名单决定，定时任务的标题就是任务标题，侧栏是一次性提问：
    // 三者都不该被自动改名（改了也没人认领，白花一次模型调用）。
    if (opts.scheduled) return
    if (session.parentId) return
    if (session.sideOf) return
    if (!isManageable(session, a)) return
    if (!isDue(a, cfg)) return
    if (running.has(session.id)) return
    if ((failures.get(session.id) ?? 0) >= MAX_CONSECUTIVE_FAILURES) return

    const model = pickModel(session, cfg)
    if (!model) {
      // 没配好模型：静默跳过（后台没人看，日志是唯一痕迹）。不给用户弹错——这不是他的操作失败。
      console.warn('[title] 没有可用模型，跳过本次标题检查')
      return
    }

    running.add(session.id)
    try {
      await checkAndApply(session, a, cfg, model)
      failures.delete(session.id)
    } catch (e) {
      const n = (failures.get(session.id) ?? 0) + 1
      failures.set(session.id, n)
      console.warn(
        `[title] 标题检查失败（${n}/${MAX_CONSECUTIVE_FAILURES}）：${(e as Error)?.message ?? e}`
      )
    } finally {
      running.delete(session.id)
    }
  } catch (e) {
    // 兜底：钩子本身出错也绝不能影响回合收尾。
    console.warn('[title] 钩子异常：', (e as Error)?.message ?? e)
  }
}

// ── 判一次、可能改一次 ──────────────────────────────────────────────────────

/** 判断模型的回落链：设置里单指 → 本对话当前模型 → 全局默认。全落空即放弃本次检查。 */
function pickModel(session: StoredSession, cfg: TitleCfg): ResolvedModel | null {
  return (
    resolveModelRefOrNull(cfg.model) ??
    resolveModelRefOrNull(session.model) ??
    resolveDefaultModel()
  )
}

/** 标题语言：显式指定优先，auto 跟随界面语言。 */
function titleLocale(cfg: TitleCfg): 'zh' | 'en' {
  if (cfg.lang === 'zh' || cfg.lang === 'en') return cfg.lang
  return isEn() ? 'en' : 'zh'
}

async function checkAndApply(
  session: StoredSession,
  a: TitleAuto,
  cfg: TitleCfg,
  model: ResolvedModel
): Promise<void> {
  const locale = titleLocale(cfg)
  const before = session.title
  const turns = a.turns

  const digest = buildDigest(session, locale)
  if (!digest.trim()) return

  const verdict = parseVerdict(await requestVerdict(model, digest, locale, session.id))
  if (!verdict) return
  if (!verdict.rename) return
  if (verdict.confidence < cfg.minConfidence) return

  const next = verdict.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  if (!next || next === before) return

  // 落笔前二次确认：检查期间用户可能又发了消息、手改了标题，甚至换了对话状态。
  const cur = getSession(session.id)
  if (!cur) return
  const curAuto = cur.titleAuto
  if (!curAuto || curAuto.turns !== turns) return
  if (!isManageable(cur, curAuto)) return
  if (cur.title !== before) return

  cur.title = next
  cur.titleAuto = { ...curAuto, turns, renamedAt: turns, corrected: true, applied: next }
  // 不改 updatedAt：改名不算新活动，列表顺序不该因它跳动（同 chat:rename-session 的约定）。
  saveSession(cur.id)
  // 左侧列表的标题当场刷新（与手机上 /new 建出空对话走同一条广播）。
  publishSessionsChanged()
  console.info(`[title] 第 ${turns} 轮自动改名：「${before}」→「${next}」`)
}

// ── 取样与请求 ─────────────────────────────────────────────────────────────

/** 首条真实用户请求：跳过压缩摘要与自动催办这类系统注入的消息。 */
function firstUserRequest(session: StoredSession): string {
  for (const m of session.messages) {
    if (m.role !== 'user') continue
    if (isCompactionSummary(m) || isAutoNudge(m) || isTaskNotification(m)) continue
    if (typeof m.content === 'string') {
      const t = m.content.trim()
      if (t) return t.slice(0, FIRST_REQUEST_CHARS)
      continue
    }
    const text = m.content
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join(' ')
      .trim()
    if (text) return text.slice(0, FIRST_REQUEST_CHARS)
  }
  return ''
}

/** 交给模型的取样：首条请求 + 当前标题 + 最近若干条消息的转录。 */
function buildDigest(session: StoredSession, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh'
  const first = firstUserRequest(session)
  const recent = buildTranscript(session.messages.slice(-DIGEST_MESSAGES), locale, DIGEST_CHARS)
  const parts = [
    first ? `【${zh ? '首条请求' : 'first request'}】${first}` : '',
    `【${zh ? '当前标题' : 'current title'}】${session.title || '（空）'}`,
    `【${zh ? '最近对话' : 'recent turns'}】\n${recent}`
  ]
  return parts.filter(Boolean).join('\n\n')
}

const SYSTEM_ZH =
  '你在为一段「开发者与 AI 助手」的对话审查标题。任务是判断已有标题是否准确概括了这段对话**真正的**需求与结果。\n' +
  '规则：\n' +
  '① 准确就保留——不要为了换个说法而改名（rename 填 false）。\n' +
  '② 明显失准才改：原标题只反映了试探性提问、贴的一段报错、或已被后来的讨论取代。\n' +
  '③ 新标题用简洁中文，突出**具体对象**与**核心任务**，保留必要的项目名与技术词，不超过 20 字；' +
  '不加引号 / 书名号，不以「关于」「一个」「问题」之类的空话开头。\n' +
  '④ 若标注了「已校正过」，则只有主要话题确实变了才再改。\n' +
  '只输出一个 JSON 对象，不要任何其它文字：\n' +
  '{"rename":true|false,"title":"新标题（rename 为 false 时留空）","reason":"一句话理由","confidence":0.0~1.0}\n' +
  'confidence 是你对这个判断正确与否的自评；低于 0.9 就不要改名。'

const SYSTEM_EN =
  'You review the title of a developer–AI assistant conversation. Decide whether the existing title accurately ' +
  'captures what the conversation is really about.\n' +
  'Rules:\n' +
  '① Keep it if accurate — never rename just to reword it (set rename to false).\n' +
  '② Only rename when clearly off: the title merely reflects a tentative opening question, a pasted error, ' +
  'or something later superseded.\n' +
  '③ The new title must be concise English, naming the concrete object and core task, keeping project names and ' +
  'technical terms; at most 60 characters; no quotes, no filler openings like "About" or "A question regarding".\n' +
  '④ If marked as already corrected, only rename when the main topic genuinely changed.\n' +
  'Output exactly one JSON object and nothing else:\n' +
  '{"rename":true|false,"title":"new title (empty when rename is false)","reason":"one-line reason","confidence":0.0-1.0}\n' +
  'confidence is your self-assessed certainty; below 0.9 means do not rename.'

/** 发一次判断请求，收集正文。只接受「干净收尾」的结果——半截输出解析不出完整 JSON。 */
async function requestVerdict(
  model: ResolvedModel,
  digest: string,
  locale: 'zh' | 'en',
  sessionId: string
): Promise<string> {
  const zh = locale === 'zh'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS)

  let text = ''
  let stopReason = ''
  let failure = ''
  try {
    for await (const ev of streamChat(
      { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
      {
        model: model.model,
        system: zh ? SYSTEM_ZH : SYSTEM_EN,
        sessionId,
        messages: [{ role: 'user', content: digest }],
        maxTokens: CHECK_MAX_TOKENS,
        // 不传 temperature：新版 Claude 已弃用该参数，传了直接 400（同 compaction.ts 的取舍）。
        // 思考档位固定 low：这是一次结构化的短判断，不需要深度推理。
        effort: effortRequest(
          model.adapter,
          model.model,
          model.baseURL,
          clampEffort(model.adapter, model.model, 'low')
        ),
        signal: ctrl.signal
      }
    )) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'error') failure = ev.error.message
      else if (ev.type === 'done') stopReason = ev.stopReason
    }
  } finally {
    clearTimeout(timer)
  }

  if (failure) throw new Error(failure)
  if (stopReason === 'error' || stopReason === 'aborted') throw new Error('判断请求未正常收尾')
  if (!text.trim()) throw new Error('判断请求没有返回正文')
  return text
}

interface Verdict {
  rename: boolean
  title: string
  reason: string
  confidence: number
}

/** 从模型输出里抠出那个 JSON 对象。模型常见的额外包装（```json 围栏、前后说明文字）都先剥掉。 */
function parseVerdict(raw: string): Verdict | null {
  let s = raw.trim()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    if (nl >= 0) s = s.slice(nl + 1)
    const end = s.lastIndexOf('```')
    if (end >= 0) s = s.slice(0, end)
    s = s.trim()
  }
  const open = s.indexOf('{')
  const close = s.lastIndexOf('}')
  if (open < 0 || close <= open) return null
  let obj: unknown
  try {
    obj = JSON.parse(s.slice(open, close + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const confidence = typeof o.confidence === 'number' ? o.confidence : 0
  return {
    rename: o.rename === true,
    title: typeof o.title === 'string' ? o.title : '',
    reason: typeof o.reason === 'string' ? o.reason : '',
    confidence: confidence >= 0 && confidence <= 1 ? confidence : 0
  }
}
