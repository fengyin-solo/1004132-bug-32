import { createServer } from 'vite'
import { strict as assert } from 'node:assert'

// 通过 Vite SSR 加载 TS 源码（含 @ 别名），在 Node 里验证牵引车调度业务逻辑。
const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' })
try {
  const store = await server.ssrLoadModule('/src/data/local-store.ts')
  const svc = await server.ssrLoadModule('/src/api/pushback-service.ts')

  const fresh = () => {
    store.resetRows('pushback')
    store.resetRows('stand')
  }

  // 1. 统一口径：派车口径排除「待牵引」且限定班组；历史口径保持全量
  fresh()
  const dispatch = svc.selectPushbackRows('dispatch', {}, '甲班')
  assert.ok(dispatch.every((r) => r.status !== '待牵引'), '派车口径不能含未派车记录')
  assert.deepEqual(dispatch.map((r) => r['牵引编号']).sort(), ['PUSH-0002'], '甲班已派车只有 PUSH-0002')
  const history = svc.selectPushbackRows('history')
  assert.equal(history.length, 4, '历史口径保留全量 4 条')
  // 筛选条件在两种口径下一致生效
  assert.equal(svc.selectPushbackRows('dispatch', { 牵引编号: 'PUSH-0002' }, '甲班').length, 1)

  // 2. 详情同口径
  assert.ok(svc.getPushbackByCode('PUSH-0001', 'dispatch', '甲班').message, '未派车在派车口径有提示但仍返回行')
  assert.equal(svc.getPushbackByCode('PUSH-0003', 'dispatch', '甲班').message.includes('乙班'), true, '跨班组提示')
  assert.ok(svc.getPushbackByCode('PUSH-0002', 'dispatch', '甲班').row, '本班组已派车可查')
  assert.ok(svc.getPushbackByCode('PUSH-0003', 'history').row, '历史口径可查跨班组')

  // 3. 回填幂等 + 现场确认优先：用派车清单（新格式，含所属班组）回灌，操作人员改不改都应保留现场值
  const exported = svc.exportPushbackDispatch({}, '甲班')
  let tampered = exported.content
    .replace('王建国', '文件改的操作员')
    .replace('无杆牵引车', '文件改的车型')
  let result = svc.backfillPushback(tampered, '甲班')
  assert.equal(result.ok, true)
  const row2 = store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0002')
  assert.equal(row2['操作人员'], '王建国', '操作人员冲突时以现场确认值为准')
  assert.equal(row2['牵引车型'], '无杆牵引车', '车型冲突时以现场确认值为准')
  assert.ok(result.protected >= 2, '应记录至少 2 个现场保留')

  // 再回灌一次同样的文件：必须幂等，不能新增同号任务
  const beforeCount = store.listRows('pushback').length
  result = svc.backfillPushback(exported.content, '甲班')
  assert.equal(store.listRows('pushback').length, beforeCount, '重复装载不多任务')
  assert.equal(result.created, 0, '重复装载不新增')

  // 4. 旧格式兼容：无「所属班组」列的旧表头也能解析并更新普通字段
  const oldCsv = [
    '编号,牵引编号,关联航班,牵引车型,操作人员,推出机位,推出方向,完成时间,牵引状态,当前状态',
    '2,PUSH-0002,CA1831,无杆牵引车,王建国,118,向南,2026-10-07 09:00,已就位,已就位',
  ].join('\n')
  result = svc.backfillPushback(oldCsv, '甲班')
  const oldRow = store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0002')
  assert.equal(oldRow['完成时间'], '2026-10-07 09:00', '旧格式普通字段可回填')
  assert.equal(oldRow['所属班组'], '甲班', '旧格式不改班组归属')

  // 5. 跨班组车辆不能改动：甲班身份回填乙班 PUSH-0003
  const crossCrew = [
    '牵引编号,操作人员,推出机位,所属班组,当前状态',
    'PUSH-0003,被改操作员,999,乙班,推出中',
  ].join('\n')
  result = svc.backfillPushback(crossCrew, '甲班')
  const crewRow = store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0003')
  assert.equal(crewRow['操作人员'], '李海燕', '跨班组操作人员不被覆盖')
  assert.equal(crewRow['推出机位'], '307', '跨班组机位不被覆盖')
  assert.ok(result.skipped >= 1, '跨班组计入跳过')

  // 6. 新编号只新增一次，且归属当前班组
  const addNew = '牵引编号,操作人员,当前状态\nPUSH-0099,新人,待牵引\n'
  result = svc.backfillPushback(addNew, '甲班')
  assert.equal(result.created, 1)
  const nr = store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0099')
  assert.equal(nr['所属班组'], '甲班', '新任务归属当前班组')

  // 7. 状态不能回填成旧值
  const downgrade = '牵引编号,当前状态\nPUSH-0002,待牵引\n'
  svc.backfillPushback(downgrade, '甲班')
  assert.equal(store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0002').status, '已就位', '状态不回退')

  // 8. 机位分配待办同步：派车任务产生已分配待办；完成后流转为已释放；幂等
  fresh()
  // PUSH-0004 在初始数据里已完成且从未有待办：不应为它补造历史
  const pushed1 = svc.syncStandTodos()
  const standsAfterDispatch = store.listRows('stand').filter((s) => String(s['备注说明']).startsWith('牵引待办：'))
  assert.equal(pushed1, 2, `在途派车 2 条应同步待办，实际 ${pushed1}`)
  assert.deepEqual(
    standsAfterDispatch.map((s) => s['机位编号']).sort(),
    ['118', '307'],
    '机位来自推出机位，已完成的 PUSH-0004 不补造待办',
  )
  assert.ok(standsAfterDispatch.every((s) => s.status === '已分配'), '初始为已分配待办')
  const pushed2 = svc.syncStandTodos()
  assert.equal(pushed2, 0, '重复同步不新增待办')
  // 走完 PUSH-0002 的现场流程：开始推出 → 确认完成，其 118 待办应流转为已释放
  const p2 = store.listRows('pushback').find((r) => r['牵引编号'] === 'PUSH-0002')
  svc.runPushbackAction(p2.id, '开始推出')
  svc.runPushbackAction(p2.id, '确认完成')
  const releasedStand = store.listRows('stand').find((s) => s['备注说明'] === '牵引待办：PUSH-0002')
  assert.equal(releasedStand.status, '已释放', '完成牵引的机位待办关闭为已释放')
  assert.equal(releasedStand.pending, false)

  // 9. 历史导出口径：旧表头（9 列、无所属班组）
  const hist = svc.exportPushbackHistory()
  const histHeader = hist.content.split('\n')[0].replace(/^﻿/, '')
  assert.equal(histHeader, '编号,牵引编号,关联航班,牵引车型,操作人员,推出机位,推出方向,完成时间,牵引状态,当前状态')
  assert.equal(hist.filename, '牵引车调度-清单.csv', '历史沿用旧文件名')

  console.log('全部断言通过 ✔')
} finally {
  await server.close()
}
