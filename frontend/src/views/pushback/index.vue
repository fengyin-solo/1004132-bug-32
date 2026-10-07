<template>
  <section class="page" data-module="pushback">
    <header class="page-head">
      <div>
        <h2>牵引车调度管理</h2>
        <p class="page-desc">维护牵引任务，围绕牵引编号、关联航班、牵引车型、操作人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记牵引任务</button>
        <button class="btn" type="button" @click="exportRows">导出牵引车调度清单</button>
        <button class="btn" type="button" @click="triggerImport">回填牵引清单文件</button>
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          accept=".csv,text/csv"
          @change="handleImportFile"
        />
      </div>
    </header>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无牵引车调度数据，可先登记牵引任务</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail-panel">
      <header class="detail-head">
        <h3>牵引任务详情 · {{ detail['牵引编号'] }}</h3>
        <button class="link" type="button" @click="closeDetail">收起</button>
      </header>
      <p class="detail-meta">
        当前状态：{{ detail.status }} ｜ 所属班组：{{ detail['所属班组'] || '—' }}
        <span v-if="confirmedList.length">｜ 现场确认：{{ confirmedList.join('、') }}</span>
      </p>
      <p v-if="detailLockReason" class="error-text">{{ detailLockReason }}</p>
      <div class="detail-grid">
        <label v-for="field in columns" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="detailValues[field]" :disabled="Boolean(detailLockReason)" />
        </label>
      </div>
      <div class="detail-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="Boolean(detailLockReason)"
          @click="saveDetail"
        >
          保存现场确认
        </button>
        <span class="detail-tip">保存后这些字段记为现场确认值，文件回填冲突时以现场确认值为准。</span>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条牵引车调度记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmEntry,
  downloadEntries,
  getEntry,
  importEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('pushback')
const columns = ["牵引编号", "关联航班", "牵引车型", "操作人员", "所属班组", "推出机位", "推出方向", "完成时间", "牵引状态"]
const actions = ["派出车辆", "开始推出", "确认完成"]
const statuses = ["待牵引", "已就位", "推出中", "已完成"]
const stats = [{"label": "待牵引航班", "value": 0}, {"label": "推出中航班", "value": 0}, {"label": "已完成牵引", "value": 0}]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const fileInput = ref<HTMLInputElement | null>(null)
const detail = ref<EntryRow | null>(null)
const detailValues = ref<Record<string, string>>({})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const confirmedList = computed(() =>
  String(detail.value?.confirmed ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean),
)
const detailLockReason = computed(() => {
  if (!detail.value) {
    return ''
  }
  const rowTeam = String(detail.value['所属班组'] ?? '').trim()
  if (rowTeam && session.team && rowTeam !== session.team) {
    return `该牵引任务属于「${rowTeam}」，跨班组车辆不能改动`
  }
  if (String(detail.value.status) === statuses[statuses.length - 1]) {
    return '该牵引任务已完结，历史记录按原口径保留，不能再改动'
  }
  return ''
})

function resetFilters() {
  filters.value = {}
  reload()
}

// 导出与列表用同一筛选条件：按牵引编号查到哪条，文件里就是哪条。
function exportRows() {
  downloadEntries(meta.key, filters.value)
}

function triggerImport() {
  fileInput.value?.click()
}

function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const result = importEntries(meta.key, String(reader.result ?? ''), { team: session.team })
    if (result.ok) {
      noticeMessage.value = result.message
      errorMessage.value = ''
    } else {
      errorMessage.value = result.message
    }
    reload()
  }
  reader.onerror = () => {
    errorMessage.value = '牵引清单文件读取失败，请重试'
  }
  reader.readAsText(file, 'utf-8')
}

function openCreate() {
  errorMessage.value = '牵引任务登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  errorMessage.value = ''
  try {
    const fresh = getEntry(meta.key, Number(row.id))
    detail.value = fresh
    const values: Record<string, string> = {}
    for (const field of columns) {
      values[field] = String(fresh[field] ?? '')
    }
    detailValues.value = values
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '牵引任务详情读取失败'
  }
}

function closeDetail() {
  detail.value = null
}

function saveDetail() {
  if (!detail.value) {
    return
  }
  errorMessage.value = ''
  const result = confirmEntry(meta.key, Number(detail.value.id), detailValues.value, {
    team: session.team,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  openDetail(detail.value)
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, { team: session.team })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '牵引车调度列表读取失败'
  }
}

onMounted(reload)
</script>
