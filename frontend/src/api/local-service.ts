import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ImportResult,
  ImportStats,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 现场确认标记存放在记录上的字段名：值是被确认字段的字段名，用 ; 分隔。
// 凡是被现场确认过的字段，文件回填冲突时以现场确认值为准。
const CONFIRMED_KEY = 'confirmed'
// 班组字段：登记了班组且与当前值班班组不一致的记录，动作、回填、确认都不能改动。
const TEAM_FIELD = '所属班组'
// 机位分配清单上由牵引车调度同步推出的待办：结构化字段 + 备注里的可读标记。
const STAND_KEY = 'stand'
const STAND_TODO_FIELD = '牵引待办'
const STAND_TODO_PATTERN = /【牵引待办:[^】]*】/g
// 牵引任务处于这些状态时，对应机位需要挂待办。
const STAND_TODO_STATUSES = ['已就位', '推出中']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 详情与列表、导出读同一份数据：按 id 从当前存储里取，保证牵引车型等字段处处一致。
export function getEntry(key: string, id: number): EntryRow {
  const meta = moduleMeta(key)
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  return JSON.parse(JSON.stringify(row)) as EntryRow
}

function confirmedFieldsOf(row: EntryRow): string[] {
  return String(row[CONFIRMED_KEY] ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

function withConfirmed(row: EntryRow, fields: string[]): EntryRow {
  const merged = [...new Set([...confirmedFieldsOf(row), ...fields])]
  return { ...row, [CONFIRMED_KEY]: merged.join(';') }
}

function teamOf(row: EntryRow): string {
  return String(row[TEAM_FIELD] ?? '').trim()
}

// 跨班组车辆不能改动：记录归属班组与当前值班班组都登记且不一致时锁定。
function teamLocked(row: EntryRow, context: ActionContext): boolean {
  const rowTeam = teamOf(row)
  const sessionTeam = (context.team ?? '').trim()
  return rowTeam !== '' && sessionTeam !== '' && rowTeam !== sessionTeam
}

function teamLockedMessage(meta: ModuleMeta, row: EntryRow): string {
  return `${meta.entity}${row[meta.fields[0]] ?? ''}属于「${teamOf(row)}」，跨班组车辆不能改动`
}

// 牵引车调度的任何变更，都要同步把待办推送到机位分配清单：机位编号对上推出机位、
// 任务处于已就位/推出中就挂待办，任务完结或机位改派即销办。机位本身的待处理标记不受影响。
export function syncStandTodos(): void {
  const pushbacks = listRows('pushback')
  const todosByStand = new Map<string, string[]>()
  for (const row of pushbacks) {
    if (!STAND_TODO_STATUSES.includes(String(row.status))) {
      continue
    }
    const standNo = String(row['推出机位'] ?? '').trim()
    const taskNo = String(row['牵引编号'] ?? '').trim()
    if (!standNo || !taskNo) {
      continue
    }
    const list = todosByStand.get(standNo) ?? []
    list.push(taskNo)
    todosByStand.set(standNo, list)
  }
  const stands = listRows(STAND_KEY)
  if (stands.length === 0) {
    return
  }
  const standMeta = moduleMeta(STAND_KEY)
  const standLastStatus = standMeta.statuses[standMeta.statuses.length - 1]
  let changed = false
  const next = stands.map((stand) => {
    const standNo = String(stand['机位编号'] ?? '').trim()
    const todos = (todosByStand.get(standNo) ?? []).join('、')
    const prev = String(stand[STAND_TODO_FIELD] ?? '')
    if (prev === todos) {
      return stand
    }
    changed = true
    const baseNote = String(stand['备注说明'] ?? '').replace(STAND_TODO_PATTERN, '').trim()
    const workflowPending = String(stand.status) !== standLastStatus
    return {
      ...stand,
      [STAND_TODO_FIELD]: todos,
      备注说明: todos ? `${baseNote ? `${baseNote} ` : ''}【牵引待办:${todos}】` : baseNote,
      pending: todos !== '' || workflowPending,
    }
  })
  if (changed) {
    saveRows(STAND_KEY, next)
  }
}

function afterPushbackChanged(key: string): void {
  if (key === 'pushback') {
    syncStandTodos()
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (teamLocked(rows[index], context)) {
    return { ok: false, message: teamLockedMessage(meta, rows[index]) }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 现场执行动作即视为对当前登记值的现场确认，之后文件回填不能覆盖这些字段。
  const confirmed = meta.fields.filter((field) => String(updated[field] ?? '').trim() !== '')
  const next = [...rows]
  next[index] = withConfirmed(updated, confirmed)
  saveRows(key, next)
  afterPushbackChanged(key)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 详情页「保存现场确认」：把页面上的值写回并整单标记为现场确认值。
export function confirmEntry(
  key: string,
  id: number,
  values: Record<string, string>,
  context: ActionContext = {},
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (teamLocked(rows[index], context)) {
    return { ok: false, message: teamLockedMessage(meta, rows[index]) }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  if (String(rows[index].status) === lastStatus) {
    return { ok: false, message: `${meta.entity}已完结，历史记录按原口径保留，不能再改动` }
  }
  let updated = { ...rows[index] }
  for (const field of meta.fields) {
    if (field in values) {
      updated[field] = values[field].trim()
    }
  }
  updated = withConfirmed(
    updated,
    meta.fields.filter((field) => String(updated[field] ?? '').trim() !== ''),
  )
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  afterPushbackChanged(key)
  return { ok: true, message: `${meta.entity}已保存现场确认值，文件回填冲突时以现场确认值为准` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  afterPushbackChanged(key)
  return listEntries(key)
}

function csvCell(value: string | number | boolean): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出与列表用同一筛选条件：列表看到什么，文件里就是什么，不会混入未派车记录。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态', '现场确认']
  const lines = [header.join(',')]
  for (const row of filterRows(listRows(key), filters)) {
    const cells = [
      row.id,
      ...meta.fields.map((field) => row[field] ?? ''),
      row.status,
      row[CONFIRMED_KEY] ?? '',
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 兼容新旧两种文件格式：带引号/不带引号、有无「编号」「现场确认」列、BOM 与 CRLF 都能读。
function parseCsv(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '')
  const table: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      cell = ''
      table.push(row)
      row = []
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  row.push(cell)
  table.push(row)
  return table.filter((line) => line.some((item) => item.trim() !== ''))
}

function emptyStats(): ImportStats {
  return { added: 0, updated: 0, keptConfirmed: 0, keptHistory: 0, keptForeign: 0, invalid: 0 }
}

// 文件回填：按业务编号（第一个字段，如牵引编号）对齐，同号只更新不新增，重复装载不会多出同号任务。
// 冲突时以现场确认值为准；已完结的历史记录按原口径保留；跨班组车辆不能改动。
export function importEntries(
  key: string,
  content: string,
  context: ActionContext = {},
): ImportResult {
  const meta = moduleMeta(key)
  const stats = emptyStats()
  const table = parseCsv(content)
  if (table.length < 2) {
    return { ok: false, message: '文件里没有可回填的数据行', stats }
  }
  const header = table[0].map((item) => item.trim())
  const businessKey = meta.fields[0]
  const keyIndex = header.indexOf(businessKey)
  if (keyIndex < 0) {
    return { ok: false, message: `文件缺少「${businessKey}」列，无法按号对齐`, stats }
  }
  const fieldColumns = meta.fields.map((field) => ({ field, index: header.indexOf(field) }))
  const statusIndex = header.indexOf('当前状态')
  const confirmedIndex = header.indexOf('现场确认')
  const rows = listRows(key)
  const byKey = new Map<string, EntryRow>()
  for (const row of rows) {
    const keyValue = String(row[businessKey] ?? '').trim()
    if (keyValue && !byKey.has(keyValue)) {
      byKey.set(keyValue, row)
    }
  }
  const firstStatus = meta.statuses[0]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const next = [...rows]

  for (const record of table.slice(1)) {
    const cell = (index: number) => (index >= 0 ? String(record[index] ?? '').trim() : '')
    const keyValue = cell(keyIndex)
    if (!keyValue) {
      stats.invalid += 1
      continue
    }
    const fileStatus = statusIndex >= 0 ? cell(statusIndex) : ''
    const fileConfirmed =
      confirmedIndex >= 0
        ? cell(confirmedIndex)
            .split(/[;；]/)
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    const existing = byKey.get(keyValue)

    if (!existing) {
      const created: EntryRow = { id: nextId, status: firstStatus, pending: true, abnormal: false }
      nextId += 1
      for (const { field, index } of fieldColumns) {
        created[field] = cell(index)
      }
      if (meta.fields.includes(TEAM_FIELD) && teamOf(created) === '' && context.team) {
        created[TEAM_FIELD] = context.team
      }
      if (fileStatus && meta.statuses.includes(fileStatus)) {
        created.status = fileStatus
      }
      created.pending = created.status !== lastStatus
      if (fileConfirmed.length > 0) {
        created[CONFIRMED_KEY] = [...new Set(fileConfirmed)].join(';')
      }
      next.push(created)
      byKey.set(keyValue, created)
      stats.added += 1
      continue
    }

    if (teamLocked(existing, context)) {
      stats.keptForeign += 1
      continue
    }
    if (String(existing.status) === lastStatus) {
      stats.keptHistory += 1
      continue
    }
    const confirmed = new Set(confirmedFieldsOf(existing))
    const updated: EntryRow = { ...existing }
    let changed = false
    for (const { field, index } of fieldColumns) {
      if (index < 0) {
        continue
      }
      const value = cell(index)
      if (value === '') {
        continue
      }
      if (confirmed.has(field)) {
        if (String(updated[field] ?? '') !== value) {
          stats.keptConfirmed += 1
        }
        continue
      }
      if (String(updated[field] ?? '') !== value) {
        updated[field] = value
        changed = true
      }
    }
    // 现场已经确认过（有确认字段或状态已流转）的记录，文件里的状态不回退现场。
    const onsiteConfirmed = confirmed.size > 0 || String(existing.status) !== firstStatus
    if (
      !onsiteConfirmed &&
      fileStatus &&
      meta.statuses.includes(fileStatus) &&
      fileStatus !== String(updated.status)
    ) {
      updated.status = fileStatus
      updated.pending = fileStatus !== lastStatus
      changed = true
    }
    const mergedConfirmed = [...new Set([...confirmed, ...fileConfirmed])]
    if (mergedConfirmed.length > confirmed.size) {
      updated[CONFIRMED_KEY] = mergedConfirmed.join(';')
      changed = true
    }
    if (changed) {
      const index = next.findIndex((row) => Number(row.id) === Number(existing.id))
      next[index] = updated
      byKey.set(keyValue, updated)
      stats.updated += 1
    }
  }

  saveRows(key, next)
  afterPushbackChanged(key)
  const parts = [`新增 ${stats.added} 条`, `更新 ${stats.updated} 条`]
  if (stats.keptConfirmed > 0) {
    parts.push(`现场确认保留 ${stats.keptConfirmed} 处`)
  }
  if (stats.keptHistory > 0) {
    parts.push(`历史记录保留 ${stats.keptHistory} 条`)
  }
  if (stats.keptForeign > 0) {
    parts.push(`跨班组跳过 ${stats.keptForeign} 条`)
  }
  if (stats.invalid > 0) {
    parts.push(`缺号跳过 ${stats.invalid} 行`)
  }
  return { ok: true, message: `回填完成：${parts.join('，')}`, stats }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
