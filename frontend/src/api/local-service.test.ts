import { beforeEach, describe, expect, it } from 'vitest'

import {
  confirmEntry,
  exportEntries,
  getEntry,
  importEntries,
  listEntries,
  runAction,
  syncStandTodos,
} from '@/api/local-service'
import { listRows, resetRows } from '@/data/local-store'

const TEAM = '一班'

function resetAll() {
  resetRows('pushback')
  resetRows('stand')
}

function csvLines(content: string): string[][] {
  return content
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.split(','))
}

beforeEach(resetAll)

describe('导出与列表同一条件', () => {
  it('按牵引编号过滤时，文件里只有匹配记录，不混入未派车记录', () => {
    const filters = { 牵引编号: 'PUSH-0002' }
    const listed = listEntries('pushback', filters)
    expect(listed.total).toBe(1)

    const { content } = exportEntries('pushback', filters)
    const lines = csvLines(content)
    expect(lines).toHaveLength(2)
    expect(lines[1][1]).toBe('PUSH-0002')
    expect(content).not.toContain('PUSH-0001')
  })

  it('详情与导出读同一份数据，牵引车型一致', () => {
    const detail = getEntry('pushback', 2)
    const { content } = exportEntries('pushback', { 牵引编号: 'PUSH-0002' })
    const lines = csvLines(content)
    const header = lines[0]
    const modelIndex = header.indexOf('牵引车型')
    expect(detail['牵引车型']).toBe('TLD-TPX400')
    expect(lines[1][modelIndex]).toBe(detail['牵引车型'])
  })
})

describe('文件回填', () => {
  it('重复装载同一份文件不会多出同号任务', () => {
    const { content } = exportEntries('pushback')
    const first = importEntries('pushback', content, { team: TEAM })
    const second = importEntries('pushback', content, { team: TEAM })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.stats.added + second.stats.added).toBe(0)

    const rows = listRows('pushback')
    const numbers = rows.map((row) => row['牵引编号'])
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(rows).toHaveLength(4)
  })

  it('冲突时以现场确认值为准，操作人员不被文件覆盖', () => {
    const file = [
      '编号,牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      ',PUSH-0002,MU5102,TLD-TPX400,李四,一班,STAN-0002,西向,,已派车,已就位',
    ].join('\n')
    const result = importEntries('pushback', file, { team: TEAM })
    expect(result.ok).toBe(true)
    expect(result.stats.keptConfirmed).toBeGreaterThan(0)

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0002')
    expect(row?.['操作人员']).toBe('张伟')
  })

  it('现场动作会把当前登记值记为现场确认值', () => {
    const action = runAction('pushback', 1, '派出车辆', { team: TEAM })
    expect(action.ok).toBe(true)

    const file = [
      '牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      'PUSH-0001,CA1831,Goldhofer-AST2,张三,一班,STAN-0001,东向,,已派车,待牵引',
    ].join('\n')
    importEntries('pushback', file, { team: TEAM })

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0001')
    expect(row?.['牵引车型']).toBe('TLD-TPX200')
    expect(String(row?.status)).toBe('已就位')
  })

  it('已完结的历史记录按原口径保留', () => {
    const file = [
      '牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      'PUSH-0004,HU7708,CHANGED,CHANGED,一班,STAN-0002,南向,,已完成,已完成',
    ].join('\n')
    const result = importEntries('pushback', file, { team: TEAM })
    expect(result.stats.keptHistory).toBe(1)

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0004')
    expect(row?.['牵引车型']).toBe('TLD-TPX200')
    expect(row?.['推出机位']).toBe('STAN-0001')
  })

  it('跨班组车辆不能改动：回填跳过、动作拒绝', () => {
    const file = [
      '牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      'PUSH-0003,CZ6607,CHANGED,CHANGED,二班,STAN-0003,南向,,推出中,推出中',
    ].join('\n')
    const result = importEntries('pushback', file, { team: TEAM })
    expect(result.stats.keptForeign).toBe(1)

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0003')
    expect(row?.['牵引车型']).toBe('Goldhofer-AST2')

    const action = runAction('pushback', 3, '确认完成', { team: TEAM })
    expect(action.ok).toBe(false)
    expect(action.message).toContain('跨班组车辆不能改动')
  })

  it('兼容旧格式：没有现场确认列、没有所属班组列也能回填', () => {
    const legacy = [
      '编号,牵引编号,关联航班,牵引车型,操作人员,推出机位,推出方向,完成时间,牵引状态,当前状态',
      '9,PUSH-0009,CA9999,TLD-TPX200,孙七,STAN-0003,东向,,待派车,待牵引',
    ].join('\n')
    const result = importEntries('pushback', legacy, { team: TEAM })
    expect(result.ok).toBe(true)
    expect(result.stats.added).toBe(1)

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0009')
    expect(row).toBeDefined()
    expect(row?.['所属班组']).toBe(TEAM)
    expect(String(row?.status)).toBe('待牵引')
  })

  it('缺少牵引编号列的文件直接拒绝', () => {
    const result = importEntries('pushback', '航班,车型\nCA123,TLD', { team: TEAM })
    expect(result.ok).toBe(false)
  })
})

describe('现场确认', () => {
  it('保存现场确认后，文件回填冲突以确认值为准', () => {
    const values: Record<string, string> = {
      牵引编号: 'PUSH-0001',
      关联航班: 'CA1831',
      牵引车型: 'TLD-TPX200',
      操作人员: '张伟',
      所属班组: '一班',
      推出机位: 'STAN-0001',
      推出方向: '东向',
      完成时间: '',
      牵引状态: '待派车',
    }
    const confirmed = confirmEntry('pushback', 1, values, { team: TEAM })
    expect(confirmed.ok).toBe(true)

    const file = [
      '牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      'PUSH-0001,CA1831,TLD-TPX200,李四,一班,STAN-0001,东向,,待派车,待牵引',
    ].join('\n')
    const result = importEntries('pushback', file, { team: TEAM })
    expect(result.stats.keptConfirmed).toBeGreaterThan(0)

    const row = listRows('pushback').find((item) => item['牵引编号'] === 'PUSH-0001')
    expect(row?.['操作人员']).toBe('张伟')
  })

  it('已完结记录与跨班组记录都不能保存现场确认', () => {
    const values = { 牵引车型: 'X' }
    expect(confirmEntry('pushback', 4, values, { team: TEAM }).ok).toBe(false)
    expect(confirmEntry('pushback', 3, values, { team: TEAM }).ok).toBe(false)
  })
})

describe('机位分配清单同步推出待办', () => {
  it('派出车辆后对应机位挂上待办，确认完成后销办', () => {
    runAction('pushback', 1, '派出车辆', { team: TEAM })

    let stand = listRows('stand').find((row) => row['机位编号'] === 'STAN-0001')
    expect(stand?.['牵引待办']).toBe('PUSH-0001')
    expect(String(stand?.['备注说明'])).toContain('【牵引待办:PUSH-0001】')
    expect(stand?.pending).toBe(true)

    runAction('pushback', 1, '开始推出', { team: TEAM })
    runAction('pushback', 1, '确认完成', { team: TEAM })

    stand = listRows('stand').find((row) => row['机位编号'] === 'STAN-0001')
    expect(stand?.['牵引待办']).toBe('')
    expect(String(stand?.['备注说明'])).not.toContain('【牵引待办')
  })

  it('启动同步时按在途牵引任务补齐机位待办', () => {
    syncStandTodos()
    const stand = listRows('stand').find((row) => row['机位编号'] === 'STAN-0002')
    expect(stand?.['牵引待办']).toBe('PUSH-0002')
    expect(stand?.pending).toBe(true)
  })

  it('回填在途任务同样同步机位待办', () => {
    const file = [
      '牵引编号,关联航班,牵引车型,操作人员,所属班组,推出机位,推出方向,完成时间,牵引状态,当前状态',
      'PUSH-0008,CA8888,TLD-TPX200,孙七,一班,STAN-0003,东向,,已派车,已就位',
    ].join('\n')
    importEntries('pushback', file, { team: TEAM })

    const stand = listRows('stand').find((row) => row['机位编号'] === 'STAN-0003')
    expect(String(stand?.['牵引待办'] ?? '')).toContain('PUSH-0008')
  })
})
