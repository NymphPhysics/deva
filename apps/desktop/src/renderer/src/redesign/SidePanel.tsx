import { useEffect, useRef, useState } from 'react'
import { ArrowUp, PanelRightClose, Square, X } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useChat } from '../store/chat'
import { Markdown } from '../features/chat/Markdown'

/**
 * 侧栏（/side 侧边提问）：挂在主对话右边的第二次对话。
 *
 * 与主对话的关系（这是它与成员会话的根本不同）：
 * - **隔离**：它是一条独立的侧栏会话（主进程侧 sideOf 指向主对话），问答只落在自己的文件里，
 *   输出绝不写回主对话；左侧列表、手机端列表、系统通知都不出现它。
 * - **背景**：首轮会带一份主对话最近几轮的快照（见 chat.ts 的 sideContextText），之后独立演进；
 *   想看主对话后来的进展，模型可用 read_main 工具翻。
 * - **权限**：文件读写与命令照常可用；回滚与按轮删除**不提供**——那两个会静默改磁盘上的真实文件，
 *   而侧栏没有主对话那套检查点提示，容易出事。
 *
 * 输入框刻意不复用主输入框 Composer：它内部的待办胶囊 / 浏览器胶囊 / 插入胶囊全部绑 currentSessionId，
 * 复用它会把主对话的状态串到这里来。
 */
export function SidePanel(): React.JSX.Element | null {
  const { t } = useI18n()
  const { side } = useChat()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // 侧栏一开就聚焦输入框（用户刚点了「就此提问」，手已经在键盘上）。
  useEffect(() => {
    if (side.id) inputRef.current?.focus()
  }, [side.id])

  // Esc 关闭侧栏（与其它面板一致）。在输入框里也认——侧栏是只读旁注，误触成本低，
  // 比「关不掉」强。组合键 / 输入法组合期间不拦。
  useEffect(() => {
    if (!side.id) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      e.stopPropagation()
      side.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [side.id, side.close])

  // 新内容到达时滚到底（侧栏内容短，不做「是否贴底」的判断，跟着走最省心）。
  const count = side.messages.length
  const lastLen = side.messages[count - 1]?.blocks.length ?? 0
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, lastLen, side.streaming])

  if (!side.id) return null

  const submit = (): void => {
    const text = draft.trim()
    if (!text || side.streaming) return
    setDraft('')
    void side.send(text).then((ok) => {
      // 没发出去（未选模型 / 请求失败 / 会话刚被删）：把草稿放回输入框，别让用户以为它发出去了。
      if (!ok) setDraft((cur) => (cur ? cur : text))
    })
  }

  return (
    <aside className="cf-sidepanel" aria-label={t('cf.side.title')}>
      <header className="cf-sidepanel__head">
        <PanelRightClose size={14} className="cf-sidepanel__icon" />
        <span className="cf-sidepanel__title" title={t('cf.side.title')}>
          {t('cf.side.title')}
        </span>
        <button
          type="button"
          className="cf-sidepanel__close"
          title={t('cf.side.close')}
          aria-label={t('cf.side.close')}
          onClick={side.close}
        >
          <X size={14} />
        </button>
      </header>

      {side.selection && (
        <div className="cf-sidepanel__quote" title={side.selection}>
          <span className="cf-sidepanel__quote-label">{t('cf.side.about')}</span>
          <span className="cf-sidepanel__quote-text">{side.selection}</span>
        </div>
      )}

      <div className="cf-sidepanel__body" ref={listRef}>
        {side.messages.length === 0 && !side.streaming ? (
          <div className="cf-sidepanel__empty">{t('cf.side.empty')}</div>
        ) : (
          side.messages.map((m) =>
            m.blocks.map((b, i) => {
              // 侧栏只渲染正文：工具步骤、思考、卡片都不在这里展开（它们是过程，不是这次提问的答案）。
              if (b.kind !== 'text') return null
              return (
                <div key={`${m.id}:${i}`} className={`cf-sidepanel__msg is-${m.role}`}>
                  <Markdown text={b.text} />
                </div>
              )
            })
          )
        )}
        {side.streaming && <div className="cf-sidepanel__working">{t('cf.side.working')}</div>}
      </div>

      <div className="cf-sidepanel__composer">
        <textarea
          ref={inputRef}
          className="cf-sidepanel__input"
          value={draft}
          placeholder={t('cf.side.placeholder')}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行（与主输入框一致）；输入法组合期间不拦。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {side.streaming ? (
          <button
            type="button"
            className="cf-sidepanel__send"
            title={t('cf.side.stop')}
            aria-label={t('cf.side.stop')}
            onClick={side.stop}
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="cf-sidepanel__send"
            title={t('cf.side.send')}
            aria-label={t('cf.side.send')}
            disabled={!draft.trim()}
            onClick={submit}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
      <div className="cf-sidepanel__foot">{t('cf.side.isolated')}</div>
    </aside>
  )
}
