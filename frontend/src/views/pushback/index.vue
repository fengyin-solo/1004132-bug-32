<template>
  <section class="page" data-module="pushback">
    <header class="page-head">
      <div>
        <h2>牵引车调度管理</h2>
        <p class="page-desc">列表、导出、详情与文件回填共用同一口径：派车口径只含本班组已派车任务，历史记录保留原全量口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记牵引任务</button>
        <button class="btn" type="button" @click="exportRows">导出当前口径清单</button>
        <button class="btn" type="button" @click="triggerImport">导入文件回填</button>
        <input ref="fileInput" type="file" accept=".csv,text/csv" hidden @change="onFilePicked" />
      </div>
    </header>

    <div class="scope-bar">
      <div class="scope-tabs" role="tablist">
        <button
          class="scope-tab"
          :class="{ active: scope === 'dispatch' }"
          type="button"
          role="tab"
          @click="switchScope('dispatch')"
        >
          派车口径（本班组已派车）
        </button>
        <button
          class="scope-tab"
          :class="{ active: scope === 'history' }"
          type="button"
          role="tab"
          @click="switchScope('history')"
        >
          历史记录（原口径全量）
        </button>
      </div>
      <label class="crew-picker">
        <span>当前班组</span>
        <select :value="store.crew" :disabled="scope === 'history'" @change="onCrewChange">
          <option v-for="crew in crews" :key="crew" :value="crew">{{ crew }}</option>
        </select>
      </label>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in visibleColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in visibleColumns" :key="column">
            <RouterLink v-if="column === '牵引编号'" class="link" :to="detailLink(row)">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="visibleColumns.length + 2" class="empty-state">
            {{ scope === 'dispatch' ? '当前筛选下没有已派车的牵引任务，未派车记录请在历史口径查看' : '暂无牵引车调度数据，可先登记牵引任务' }}
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="lastResult" class="backfill-panel">
      <h3>最近一次文件回填结果</h3>
      <p :class="lastResult.ok ? 'backfill-summary' : 'error-text'">{{ lastResult.message }}</p>
      <table class="data-table" v-if="lastResult.outcomes.length">
        <thead>
          <tr><th>牵引编号</th><th>处理结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in lastResult.outcomes" :key="item.code + item.result">
            <td>{{ item.code }}</td>
            <td>{{ outcomeLabel[item.result] }}</td>
            <td>{{ item.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条{{ scope === 'dispatch' ? `已派车记录（${store.crew}）` : '历史记录（全量原口径）' }}
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillPushback,
  downloadPushback,
  runPushbackAction,
  selectPushbackRows,
  HISTORY_FIELDS,
} from '@/api/pushback-service'
import { useSessionStore, SHIFT_CREWS } from '@/stores/session'
import type { BackfillResult, EntryRow, PushbackScope } from '@/data/types'

const store = useSessionStore()
const crews = SHIFT_CREWS

// 派车口径新增「所属班组」列；历史口径仍展示旧版列，旧文件列顺序不变。
const columns = ['牵引编号', '关联航班', '牵引车型', '操作人员', '推出机位', '推出方向', '完成时间', '牵引状态', '所属班组']
const visibleColumns = computed(() => (scope.value === 'history' ? HISTORY_FIELDS : columns))
const filterFields = ['牵引编号', '关联航班', '牵引车型']
const actions = ['派出车辆', '开始推出', '确认完成']
const statusOrder = ['待牵引', '已就位', '推出中', '已完成']

const outcomeLabel: Record<string, string> = {
  created: '新增',
  updated: '更新',
  unchanged: '一致未改',
  protected: '现场保留',
  skipped: '跨班组跳过',
  invalid: '无效跳过',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const scope = ref<PushbackScope>('dispatch')
const lastResult = ref<BackfillResult | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const statusSummary = computed(() =>
  statusOrder.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待牵引航班', value: rows.value.filter((row) => String(row.status) === '待牵引').length },
  { label: '推出中航班', value: rows.value.filter((row) => String(row.status) === '推出中').length },
  { label: '已完成牵引', value: rows.value.filter((row) => String(row.status) === '已完成').length },
])

function availableActions(row: EntryRow): string[] {
  const from = statusOrder.indexOf(String(row.status))
  return actions.filter((_, index) => index === from)
}

function detailLink(row: EntryRow) {
  return { path: '/pushback/detail', query: { code: String(row['牵引编号'] ?? ''), scope: scope.value } }
}

function switchScope(next: PushbackScope) {
  scope.value = next
  reload()
}

function onCrewChange(event: Event) {
  store.setCrew((event.target as HTMLSelectElement).value)
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadPushback(scope.value, filters.value, store.crew)
}

function triggerImport() {
  errorMessage.value = ''
  fileInput.value?.click()
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    try {
      lastResult.value = backfillPushback(String(reader.result ?? ''), store.crew)
      if (!lastResult.value.ok) {
        errorMessage.value = lastResult.value.message
      }
      reload()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '文件回填失败'
    }
  }
  reader.onerror = () => {
    errorMessage.value = '文件读取失败，请重试'
  }
  reader.readAsText(file, 'utf-8')
}

function openCreate() {
  errorMessage.value = '牵引任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runPushbackAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const matched = selectPushbackRows(scope.value, filters.value, store.crew)
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '牵引车调度列表读取失败'
  }
}

onMounted(reload)
</script>
