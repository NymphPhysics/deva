import { useEffect, useMemo, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { Modal } from '../../components/Modal'
import { Markdown } from './Markdown'
import { ImageViewer } from '../../redesign/attachments'
import { subscribeFilePreview, type FilePreviewRequest } from './preview'

/**
 * 文件预览面板（覆盖层）：把某次 read_file 的结果渲染出来，而不是只给一段纯文本。
 *
 * 内容从哪来：向主进程要那次调用的原始 tool_result（chat:tool-result）。只认 read_file 且只从历史取，
 * 渲染层给不了任意路径 —— 不是新的读盘口子。见 chat.ts 该 handler 的注释。
 *
 * 渲染走什么：全部复用手边唯一的 Markdown 渲染器（features/chat/Markdown.tsx）。
 * - .md            → 直接当 Markdown 渲染（同一套消毒基线，不启用 rehype-raw）
 * - 其它文本      → 包成围栏代码块再交给它，于是自动获得「语言名 + 复制 + 语法高亮」的既有外观
 * - 图片          → 复用 ImageViewer（ImageSource 新增了 { url } 这一种）
 * 这样零新增依赖、零新增 XSS 面：不引 monaco / codemirror（包体数 MB，且与本项目严格 CSP 有踩坑史），
 * 也绝不对 .html / .svg 做「当网页渲染」——一律按源码文本显示。
 */

/** 扩展名 → 围栏代码块的语言名（highlight.js 认这些）。 */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.bat': 'dos',
  '.cmd': 'dos',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.conf': 'ini',
  '.md': 'markdown',
  '.txt': '',
  '.log': '',
  '.csv': '',
  '.dockerfile': 'dockerfile',
  '.makefile': 'makefile',
  '.gradle': 'groovy',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.vue': 'xml'
}

function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function FilePreviewHost(): React.JSX.Element | null {
  const [req, setReq] = useState<FilePreviewRequest | null>(null)
  useEffect(() => subscribeFilePreview(setReq), [])
  if (!req) return null
  // key：换一个文件就整份重挂载，免得沿用上一个的加载态 / 滚动位置。
  return <FilePreview key={req.toolUseId} req={req} onClose={() => setReq(null)} />
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ok'; text: string; images: string[]; path: string }

function FilePreview({
  req,
  onClose
}: {
  req: FilePreviewRequest
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<Loaded>({ state: 'loading' })

  useEffect(() => {
    let live = true
    void window.deva.chat
      .toolResult(req.sessionId, req.toolUseId)
      .then((r) => {
        if (!live) return
        setData(
          r ? { state: 'ok', text: r.text, images: r.images, path: r.path } : { state: 'error' }
        )
      })
      .catch(() => {
        if (live) setData({ state: 'error' })
      })
    return () => {
      live = false
    }
  }, [req.sessionId, req.toolUseId])

  const name = req.name || (data.state === 'ok' ? data.path : '')
  const ext = extOf(name)

  const [viewing, setViewing] = useState(false)

  const images = data.state === 'ok' ? data.images : []

  const body = useMemo(() => {
    if (data.state !== 'ok') return null
    const text = data.text
    if (!text.trim()) return null
    if (ext === '.md' || ext === '.markdown') return <Markdown text={text} />
    // 其它文本：包成围栏块交给同一个渲染器 —— 语言名、复制键、语法高亮全是现成的。
    const lang = LANG_BY_EXT[ext] ?? ''
    return <Markdown text={`\`\`\`${lang}\n${text}\n\`\`\``} />
  }, [data, ext])

  return (
    <Modal open onClose={onClose} width={940} labelledBy="file-preview-title">
      <div className="fprev">
        <div className="fprev__head">
          <span className="fprev__name" id="file-preview-title" title={data.state === 'ok' ? data.path : name}>
            {name}
          </span>
          <span className="fprev__ext">{ext || t('chat.preview.unknown')}</span>
        </div>
        <div className="fprev__body">
          {data.state === 'loading' && <div className="fprev__note">{t('chat.preview.loading')}</div>}
          {data.state === 'error' && (
            <div className="fprev__note">
              <FileWarning size={16} />
              {t('chat.preview.missing')}
            </div>
          )}
          {data.state === 'ok' &&
            (images.length ? (
              <button type="button" className="fprev__thumb" onClick={() => setViewing(true)}>
                <img
                  src={images[0]}
                  alt={name}
                  title={t('chat.preview.openImage')}
                />
                {images.length > 1 && (
                  <span className="fprev__thumb-n">{t('chat.preview.imageCount').replace('{n}', String(images.length))}</span>
                )}
              </button>
            ) : (
              (body ?? <div className="fprev__note">{t('chat.preview.empty')}</div>)
            ))}
        </div>
      </div>
      {viewing && images.length > 0 && (
        <ImageViewer
          items={images.map((url, i) => ({
            src: { url },
            name: images.length > 1 ? `${name} (${i + 1})` : name
          }))}
          index={0}
          onClose={() => setViewing(false)}
        />
      )}
    </Modal>
  )
}
