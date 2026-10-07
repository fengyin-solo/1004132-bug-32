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

/** 操作上下文：目前只带当前值班班组，用于「跨班组车辆不能改动」的守卫。 */
export type ActionContext = {
  team?: string
}

export type ImportStats = {
  added: number
  updated: number
  /** 文件与现场确认值冲突、按现场确认保留的字段处数 */
  keptConfirmed: number
  /** 已完结的历史记录，按原口径保留的条数 */
  keptHistory: number
  /** 属于其他班组、不能改动的条数 */
  keptForeign: number
  /** 缺业务编号、无法对齐的行数 */
  invalid: number
}

export type ImportResult = {
  ok: boolean
  message: string
  stats: ImportStats
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
