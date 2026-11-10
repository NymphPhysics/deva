/**
 * 文件预览的开合总线（模块级单例 + 订阅）。
 *
 * 为什么不用 props 逐层传：预览入口在时间轴的工具步骤里（blocks.tsx 的 TimelineTool），
 * 而宿主面板挂在 Conversation 上，中间隔着 ProcessFold → MessageRow → Timeline 好几层，
 * 每层都不需要知道这件事。仓库对这类「深处触发、高处渲染」已有同样写法（输入框草稿总线、
 * 实时输入框实例），这里照办。
 */

export interface FilePreviewRequest {
  /** 该次 read_file 调用所在的会话。 */
  sessionId: string
  /** 那次工具调用的 id（历史里按它找 tool_result）。 */
  toolUseId: string
  /** 文件名，用于标题与判类型（路径可能是相对路径，见主进程 ToolResultView.path）。 */
  name: string
}

let listener: ((req: FilePreviewRequest) => void) | null = null

/**
 * 当前正在看的会话 id。由对话外壳在切换会话时登记：时间轴里的工具步骤拿不到 prop，
 * 而 read_file 的结果必须按它所属的会话去取（切走之后才点开也不能取错）。
 */
let currentSessionId = ''

export function setPreviewSession(sessionId: string): void {
  currentSessionId = sessionId
}

export function previewSessionId(): string {
  return currentSessionId
}

/** 打开预览：没有宿主挂载时静默忽略（不该发生——宿主随对话外壳一直在）。 */
export function openFilePreview(req: FilePreviewRequest): void {
  listener?.(req)
}

/** 宿主订阅（同一时刻只允许一个宿主，与仓库其它总线的约定一致）。 */
export function subscribeFilePreview(cb: (req: FilePreviewRequest) => void): () => void {
  listener = cb
  return () => {
    if (listener === cb) listener = null
  }
}
