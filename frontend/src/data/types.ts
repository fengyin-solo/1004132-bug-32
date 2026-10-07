/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 牵引车调度的查询口径：派车（现场）口径只含已派车记录；历史口径保持原全量口径。 */
export type PushbackScope = 'dispatch' | 'history'

/** 文件回填的逐条处理结果，操作人员核对时能看清每行为什么没改。 */
export type BackfillOutcome = {
  code: string
  result: 'created' | 'updated' | 'unchanged' | 'protected' | 'skipped' | 'invalid'
  detail: string
}

/** 文件回填整体结果。 */
export type BackfillResult = {
  ok: boolean
  message: string
  outcomes: BackfillOutcome[]
  created: number
  updated: number
  unchanged: number
  protected: number
  skipped: number
  invalid: number
  standTodosPushed: number
}
