import { describe, expect, it } from 'vitest'
import { RunContextLedger } from './run-context-ledger'

describe('调用指纹', () => {
  it('相同工具/目标/参数(同修订)不得执行两次', () => {
    const ledger = new RunContextLedger()
    expect(ledger.tryReserveFingerprint('read_file', { path: 'a.css' }, 1)).toBe(true)
    expect(ledger.tryReserveFingerprint('read_file', { path: 'a.css' }, 1)).toBe(false)
  })

  it('文件修订变化后同参数可以再调', () => {
    const ledger = new RunContextLedger()
    expect(ledger.tryReserveFingerprint('read_file', { path: 'a.css' }, 1)).toBe(true)
    expect(ledger.tryReserveFingerprint('read_file', { path: 'a.css' }, 2)).toBe(true)
  })

  it('指纹对键序不敏感(规范化后哈希)', () => {
    const ledger = new RunContextLedger()
    expect(ledger.tryReserveFingerprint('edit_file', { a: 1, b: 2 }, 1)).toBe(true)
    expect(ledger.tryReserveFingerprint('edit_file', { b: 2, a: 1 }, 1)).toBe(false)
  })
})

describe('补丁失败与写入熔断', () => {
  it('同文件同错误码第二次后禁用该文件的文本补丁', () => {
    const ledger = new RunContextLedger()
    ledger.recordFailure('edit_file', 'MATCH_NOT_FOUND', 'a.vue')
    expect(ledger.textPatchDisabled('a.vue')).toBe(false)
    ledger.recordFailure('apply_patch', 'MATCH_NOT_FOUND', 'a.vue')
    expect(ledger.textPatchDisabled('a.vue')).toBe(true)
    // 别的文件不受牵连
    expect(ledger.textPatchDisabled('b.vue')).toBe(false)
  })

  it('连续三次写失败后暂停写入,重新定位/读取后解除', () => {
    const ledger = new RunContextLedger()
    ledger.recordFailure('edit_file', 'MATCH_NOT_FOUND', 'a.vue')
    ledger.recordFailure('write_file', 'TOOL_EXECUTION_FAILED', 'b.vue')
    expect(ledger.writesPaused()).toBe(false)
    ledger.recordFailure('apply_patch', 'PATCH_FORMAT_INVALID')
    expect(ledger.writesPaused()).toBe(true)
    ledger.noteLocate()
    expect(ledger.writesPaused()).toBe(false)
  })

  it('写成功清零连续失败计数', () => {
    const ledger = new RunContextLedger()
    ledger.recordFailure('edit_file', 'MATCH_NOT_FOUND', 'a.vue')
    ledger.recordFailure('edit_file', 'MATCH_NOT_FOUND', 'b.vue')
    ledger.noteWriteSuccess('c.vue', 2, 'edit_file', 10)
    ledger.recordFailure('edit_file', 'MATCH_NOT_FOUND', 'd.vue')
    expect(ledger.writesPaused()).toBe(false)
  })
})

describe('致命锁', () => {
  it('致命一致性错误后禁止产出 artifact', () => {
    const ledger = new RunContextLedger()
    expect(ledger.canFinalizeArtifact()).toBe(true)
    ledger.lockFatal('SQLite 写入失败')
    expect(ledger.canFinalizeArtifact()).toBe(false)
    expect(ledger.writesPaused()).toBe(true)
    // 致命锁不能被 noteLocate 解除
    ledger.noteLocate()
    expect(ledger.writesPaused()).toBe(true)
  })
})

describe('运行事实', () => {
  it('记录完成的写与技能激活,供历史压缩生成账本', () => {
    const ledger = new RunContextLedger()
    ledger.noteWriteSuccess('a.vue', 2, 'write_file', 1200)
    ledger.activatedSkills.add('craft-admin')
    expect(ledger.completedWrites).toEqual([
      { path: 'a.vue', revision: 2, tool: 'write_file', chars: 1200 }
    ])
    expect(ledger.activatedSkills.has('craft-admin')).toBe(true)
  })
})
