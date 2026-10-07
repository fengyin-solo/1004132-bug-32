import { moduleMeta, runAction as genericRunAction } from './local-service'
import { listRows, saveRows } from '@/data/local-store'
import { parseCsv, toCsv } from '@/utils/csv'
import type { ActionResult, BackfillOutcome, BackfillResult, EntryRow, PushbackScope } from '@/data/types'

// 牵引车调度专项服务：列表、导出、详情、文件回填共用同一口径，避免各自过滤造成错位与覆盖。

const KEY = 'pushback'

export const PUSHBACK_STATUSES = ['待牵引', '已就位', '推出中', '已完成']
const DISPATCHED_STATUSES = ['已就位', '推出中', '已完成']

export const CODE_FIELD = '牵引编号'

// 现场确认字段：派车后由现场锁定，文件回填与现场冲突时一律以现场确认值为准。
export const SITE_CONFIRMED_FIELDS = ['牵引车型', '操作人员']

// 回填时允许随文件更新的非现场字段；状态只能向前推进，不能回填成旧值。
const FILE_EDITABLE_FIELDS = ['关联航班', '推出机位', '推出方向', '完成时间']

export const HISTORY_FIELDS = moduleMeta(KEY).fields.filter((field) => field !== '所属班组')
export const CURRENT_FIELDS = moduleMeta(KEY).fields

function isDispatched(row: EntryRow): boolean {
  return DISPATCHED_STATUSES.includes(String(row.status))
}

/**
 * 统一口径选择器：列表 / 导出 / 详情 / 回填统计都从这里取数。
 * - dispatch（派车口径）：只含已派车记录，并限定当前班组，未派车记录不会再混进下载文件。
 * - history（历史口径）：保留原全量口径与原字段，跨班组历史也照常可查。
 */
export function selectPushbackRows(scope: PushbackScope, filters: Record<string, string> = {}, crew?: string): EntryRow[] {
  const all = listRows(KEY)
  const scoped = scope === 'dispatch'
    ? all.filter((row) => isDispatched(row) && (crew ? String(row['所属班组'] ?? '') === crew : true))
    : all
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return scoped
  }
  return scoped.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/** 详情查询与列表、导出同一口径：按牵引编号定位，查不到或不在该口径下都明确返回原因。 */
export function getPushbackByCode(code: string, scope: PushbackScope, crew?: string): { row?: EntryRow; message?: string } {
  const trimmed = code.trim()
  const row = listRows(KEY).find((item) => String(item[CODE_FIELD] ?? '').trim() === trimmed)
  if (!row) {
    return { message: `没有找到牵引编号为「${trimmed}」的任务` }
  }
  if (scope === 'dispatch' && !isDispatched(row)) {
    return { row, message: '该任务尚未派车，不在派车口径内，可切换到历史口径查看' }
  }
  if (scope === 'dispatch' && crew && String(row['所属班组'] ?? '') !== crew) {
    return { row, message: `该任务属于${String(row['所属班组'] ?? '其他班组')}，不在当前班组派车口径内` }
  }
  return { row }
}

function normalizeStatus(value: string): string {
  const text = value.trim()
  return PUSHBACK_STATUSES.includes(text) ? text : ''
}

function buildPushbackCsv(rows: EntryRow[], includeCrew: boolean): string {
  const fields = includeCrew ? CURRENT_FIELDS : HISTORY_FIELDS
  const header = ['编号', ...fields, '当前状态']
  const lines: (string | number | boolean)[][] = [header]
  for (const row of rows) {
    lines.push([row.id, ...fields.map((field) => row[field] ?? ''), row.status])
  }
  return toCsv(lines)
}

/** 派车清单导出（新口径）：仅已派车 + 当前班组 + 页面筛选条件，文件名体现口径。 */
export function exportPushbackDispatch(filters: Record<string, string> = {}, crew?: string): { filename: string; content: string } {
  const rows = selectPushbackRows('dispatch', filters, crew)
  return {
    filename: '牵引车调度-派车清单.csv',
    content: buildPushbackCsv(rows, true),
  }
}

/** 历史记录导出：严格沿用旧版表头（无「所属班组」列）与旧文件名，保持原口径。 */
export function exportPushbackHistory(filters: Record<string, string> = {}): { filename: string; content: string } {
  const rows = selectPushbackRows('history', filters)
  return {
    filename: '牵引车调度-清单.csv',
    content: buildPushbackCsv(rows, false),
  }
}

function downloadCsv(filename: string, content: string): void {
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

export function downloadPushback(scope: PushbackScope, filters: Record<string, string>, crew: string): void {
  const payload = scope === 'dispatch'
    ? exportPushbackDispatch(filters, crew)
    : exportPushbackHistory(filters)
  downloadCsv(payload.filename, payload.content)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function blankRow(id: number, code: string, crew: string): EntryRow {
  return {
    id,
    status: '待牵引',
    pending: true,
    abnormal: false,
    [CODE_FIELD]: code,
    关联航班: '',
    牵引车型: '',
    操作人员: '',
    推出机位: '',
    推出方向: '',
    完成时间: '',
    牵引状态: '待牵引',
    所属班组: crew,
  }
}

/**
 * 文件回填：
 * - 按牵引编号 upsert，重复装载同一文件不会再生成同号任务；
 * - 现场确认字段（车型、操作人员）与文件冲突时保留现场值；
 * - 跨班组车辆整行跳过，绝不改动；
 * - 旧版表头（无「所属班组」列、带 编号/当前状态 列）照常识别。
 */
export function backfillPushback(content: string, crew: string): BackfillResult {
  const table = parseCsv(content)
  if (table.length < 2) {
    return emptyResult('文件没有可回填的数据行')
  }
  const header = table[0].map((cell) => cell.trim())
  const indexOf = (...names: string[]) => header.findIndex((cell) => names.includes(cell))
  const codeIdx = indexOf(CODE_FIELD)
  if (codeIdx < 0) {
    return emptyResult('文件缺少「牵引编号」列，无法回填')
  }
  const value = (cells: string[], ...names: string[]) => {
    const idx = indexOf(...names)
    return idx >= 0 ? (cells[idx] ?? '').trim() : ''
  }

  const rows = [...listRows(KEY)]
  const outcomes: BackfillOutcome[] = []
  const counters = { created: 0, updated: 0, unchanged: 0, protected: 0, skipped: 0, invalid: 0 }

  for (const cells of table.slice(1)) {
    const code = (cells[codeIdx] ?? '').trim()
    if (!code) {
      counters.invalid += 1
      outcomes.push({ code: '(空)', result: 'invalid', detail: '缺少牵引编号，已跳过' })
      continue
    }
    const index = rows.findIndex((row) => String(row[CODE_FIELD] ?? '').trim() === code)
    const incomingCrew = value(cells, '所属班组')

    if (index >= 0) {
      const current = rows[index]
      const currentCrew = String(current['所属班组'] ?? '').trim()
      if (currentCrew && currentCrew !== crew) {
        counters.skipped += 1
        outcomes.push({ code, result: 'skipped', detail: `属于${currentCrew}的跨班组车辆，按规定不改动` })
        continue
      }

      const merged: EntryRow = { ...current }
      const notes: string[] = []
      let changed = false

      // 现场确认字段：已派车记录锁定；文件值与现场不一致时保留现场值并记录冲突。
      for (const field of SITE_CONFIRMED_FIELDS) {
        const incoming = value(cells, field)
        if (!incoming) {
          continue
        }
        const existing = String(merged[field] ?? '').trim()
        if (existing && incoming !== existing && isDispatched(current)) {
          counters.protected += 1
          notes.push(`${field}以现场确认值「${existing}」为准（文件值：${incoming}）`)
        } else if (!existing) {
          merged[field] = incoming
          changed = true
        }
      }

      // 普通字段：仅在文件提供了非空新值时更新。
      for (const field of FILE_EDITABLE_FIELDS) {
        const incoming = value(cells, field)
        if (incoming && incoming !== String(merged[field] ?? '').trim()) {
          merged[field] = incoming
          changed = true
        }
      }

      // 班组字段：只能补空，不允许通过文件改派到别的班组。
      if (!String(merged['所属班组'] ?? '').trim() && incomingCrew) {
        merged['所属班组'] = incomingCrew
        changed = true
      }

      // 状态只能向前推进；文件里是旧状态时保留现场状态。
      const incomingStatus = normalizeStatus(value(cells, '当前状态', '牵引状态'))
      if (incomingStatus) {
        const from = PUSHBACK_STATUSES.indexOf(String(merged.status))
        const to = PUSHBACK_STATUSES.indexOf(incomingStatus)
        if (to > from) {
          merged.status = incomingStatus
          merged.pending = incomingStatus !== PUSHBACK_STATUSES[PUSHBACK_STATUSES.length - 1]
          merged['牵引状态'] = incomingStatus
          changed = true
        } else if (to < from) {
          notes.push(`状态保留现场「${String(merged.status)}」，不回填旧状态「${incomingStatus}」`)
        }
      }

      if (!changed) {
        counters.unchanged += 1
        outcomes.push({ code, result: 'unchanged', detail: notes.length ? notes.join('；') : '与现场一致，无需更新' })
      } else {
        counters.updated += 1
        rows[index] = merged
        outcomes.push({ code, result: 'updated', detail: notes.length ? `已按文件更新；${notes.join('；')}` : '已按文件更新' })
      }
    } else {
      // 新编号：新增任务，归属当前班组，不允许借文件直接落到别的班组。
      const row = blankRow(nextId(rows), code, incomingCrew && incomingCrew === crew ? incomingCrew : crew)
      for (const field of [...SITE_CONFIRMED_FIELDS, ...FILE_EDITABLE_FIELDS]) {
        const incoming = value(cells, field)
        if (incoming) {
          row[field] = incoming
        }
      }
      const incomingStatus = normalizeStatus(value(cells, '当前状态', '牵引状态'))
      if (incomingStatus) {
        row.status = incomingStatus
        row.pending = incomingStatus !== PUSHBACK_STATUSES[PUSHBACK_STATUSES.length - 1]
        row['牵引状态'] = incomingStatus
      }
      rows.push(row)
      counters.created += 1
      const crewNote = incomingCrew && incomingCrew !== crew ? `文件标注${incomingCrew}，已归到当前班组${crew}` : ''
      outcomes.push({ code, result: 'created', detail: crewNote ? `新增待牵引任务；${crewNote}` : '新增待牵引任务' })
    }
  }

  saveRows(KEY, rows)
  const standTodosPushed = syncStandTodos()
  const message = `回填完成：新增 ${counters.created}，更新 ${counters.updated}，一致 ${counters.unchanged}，现场保留 ${counters.protected}，跨班组跳过 ${counters.skipped}，无效 ${counters.invalid}；同步机位待办 ${standTodosPushed} 条`

  return { ok: true, message, outcomes, ...counters, standTodosPushed }
}

function emptyResult(message: string): BackfillResult {
  return {
    ok: false,
    message,
    outcomes: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    protected: 0,
    skipped: 0,
    invalid: 0,
    standTodosPushed: 0,
  }
}

// —— 机位分配待办同步 ——

/** 牵引状态流转后：走通用动作逻辑，成功后把派车结果同步成机位分配待办。 */
export function runPushbackAction(id: number, action: string): ActionResult {
  const result = genericRunAction(KEY, id, action)
  if (result.ok) {
    syncStandTodos()
  }
  return result
}

const STAND_KEY = 'stand'
const TODO_REMARK_PREFIX = '牵引待办：'

function standTodoRef(code: string): string {
  return `${TODO_REMARK_PREFIX}${code}`
}

/**
 * 把已派车的牵引任务同步成「机位分配」待办：
 * - 按牵引编号幂等，重复同步不新增；
 * - 牵引完成后，只关闭仍停留在「已分配」、现场未推进的待办；
 *   现场已确认占用/释放的机位以现场值为准，不被同步覆盖。
 */
export function syncStandTodos(): number {
  const dispatched = listRows(KEY).filter((row) => isDispatched(row))
  const stands = [...listRows(STAND_KEY)]
  let pushed = 0

  for (const task of dispatched) {
    const standNo = String(task['推出机位'] ?? '').trim()
    if (!standNo) {
      continue
    }
    const code = String(task[CODE_FIELD] ?? '').trim()
    const remark = standTodoRef(code)
    const index = stands.findIndex((row) => String(row['备注说明'] ?? '') === remark)
    const finished = String(task.status) === '已完成'

    if (index < 0) {
      if (finished) {
        continue
      }
      stands.push({
        id: nextId(stands),
        status: '已分配',
        pending: true,
        abnormal: false,
        机位编号: standNo,
        机位类型: '',
        所属航站楼: '',
        匹配航班: String(task['关联航班'] ?? ''),
        计划占用: '',
        实际占用: '',
        分配状态: '已分配',
        备注说明: remark,
      })
      pushed += 1
    } else if (finished && String(stands[index].status) === '已分配') {
      stands[index] = { ...stands[index], status: '已释放', pending: false, 分配状态: '已释放' }
      pushed += 1
    }
  }

  if (pushed > 0) {
    saveRows(STAND_KEY, stands)
  }
  return pushed
}
