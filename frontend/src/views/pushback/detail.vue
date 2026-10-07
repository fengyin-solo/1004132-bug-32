<template>
  <section class="page" data-module="pushback-detail">
    <header class="page-head">
      <div>
        <h2>牵引任务详情</h2>
        <p class="page-desc">详情与派车清单、文件回填、列表使用同一口径与同一份数据，车型以现场确认值为准。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" :to="{ path: '/pushback', query: { scope } }">返回牵引车调度</RouterLink>
      </div>
    </header>

    <div class="scope-tabs" role="tablist">
      <button
        class="scope-tab"
        :class="{ active: scope === 'dispatch' }"
        type="button"
        role="tab"
        @click="switchScope('dispatch')"
      >
        派车口径（{{ store.crew }}已派车）
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

    <p v-if="notice" class="scope-notice">{{ notice }}</p>
    <p v-if="!row" class="error-text">{{ notice || '未找到该牵引任务' }}</p>

    <table v-if="row" class="data-table detail-table">
      <tbody>
        <tr v-for="field in detailFields" :key="field">
          <th>{{ field }}</th>
          <td>
            {{ row[field] || '—' }}
            <span v-if="isSiteField(field) && isDispatched(row)" class="confirm-tag">现场确认值</span>
          </td>
        </tr>
        <tr>
          <th>当前状态</th>
          <td>{{ row.status }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { getPushbackByCode, SITE_CONFIRMED_FIELDS } from '@/api/pushback-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, PushbackScope } from '@/data/types'

const route = useRoute()
const router = useRouter()
const store = useSessionStore()

const detailFields = ['牵引编号', '关联航班', '牵引车型', '操作人员', '所属班组', '推出机位', '推出方向', '完成时间', '牵引状态']
const DISPATCHED = ['已就位', '推出中', '已完成']

const row = ref<EntryRow | null>(null)
const notice = ref('')
const scope = ref<PushbackScope>(route.query.scope === 'history' ? 'history' : 'dispatch')

const code = computed(() => String(route.query.code ?? ''))

function isSiteField(field: string): boolean {
  return SITE_CONFIRMED_FIELDS.includes(field)
}

function isDispatched(target: EntryRow): boolean {
  return DISPATCHED.includes(String(target.status))
}

function switchScope(next: PushbackScope) {
  scope.value = next
  router.replace({ query: { ...route.query, scope: next } })
}

function load() {
  if (!code.value) {
    row.value = null
    notice.value = '缺少牵引编号，请从列表进入详情'
    return
  }
  const result = getPushbackByCode(code.value, scope.value, store.crew)
  row.value = result.row ?? null
  notice.value = result.message ?? ''
}

watch(scope, load)
onMounted(load)
</script>
