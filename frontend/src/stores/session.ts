import { defineStore } from 'pinia'

export const SHIFT_CREWS = ['甲班', '乙班', '丙班']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    crew: '甲班',
    scope: '机场地面保障调度管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCrew(crew: string) {
      this.crew = crew
    },
  },
})
