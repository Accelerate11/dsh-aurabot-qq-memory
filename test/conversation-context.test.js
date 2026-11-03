import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationArchive, queriesFor, retrieve, packEvidence, recentWithin } from '../src/chat/conversation-context.js'
import { buildIndex, search, createMemoryStore } from '../src/features/memory.js'

test('省略说法可以借助多轮用户线索，明确转题不会带入旧主题', () => {
  const recent = [{ role: 'user', text: 'Coffee温控怎么调' }, { role: 'assistant', text: '试试低一点的水温' }, { role: 'user', text: '嗯' }]
  assert.ok(queriesFor('那后来呢', recent).some(q => q.includes('Coffee')))
  assert.deepEqual(queriesFor('换个话题，聊盆栽', recent), ['换个话题，聊盆栽'])
})

test('相关性检索不会给完全无关的问题制造记忆兜底', () => {
  const docs = [{ id: 'a', text: 'Coffee温控需要稳定' }, { id: 'b', text: '盆栽每周浇水' }]
  assert.equal(retrieve(['Coffee'], docs)[0].id, 'a')
  assert.deepEqual(retrieve(['火星婚礼'], docs), [])
})

test('预算保留完整证据记录，不截断JSON，并尝试后面的较小记录', () => {
  const result = packEvidence([{ text: 'x'.repeat(100) }, { text: 'Coffee' }], JSON.stringify, 30)
  assert.equal(JSON.parse(result.text).text, 'Coffee')
  assert.ok(result.characters <= 30)
  assert.deepEqual(recentWithin([{ role: 'user', text: 'a'.repeat(20) }, { role: 'assistant', text: 'b'.repeat(20) }], 30), [])
})

test('长会话中间的事实在重启后可检索，原话角色和证据ID保持不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-archive-'))
  let archive = createConversationArchive({ directory, namespace: 'paperboat' })
  const chat = 'private:fixture'
  for (let i = 0; i < 100; i++) {
    archive.append(chat, { role: 'user', id: 'u' + i, at: 1700000000000 + i * 1000, text: i === 40 ? 'Coffee温控约定用八十八度' : '今天讨论盆栽第' + i + '次' })
    archive.append(chat, { role: 'assistant', id: 'a' + i, at: 1700000000500 + i * 1000, text: '知道了' })
  }
  archive = createConversationArchive({ directory, namespace: 'paperboat' })
  const found = archive.recall(chat, 'Coffee温控的约定')
  assert.match(found.text, /八十八度/)
  assert.ok(found.selected.some(e => e.context.some(m => m.id === 'u40' && m.role === 'user')))
  assert.ok(found.characters <= 4000)
})

test('不同聊天、群聊和不同人格互相不能召回；重复结束事件不重复入库', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-isolation-'))
  const a = createConversationArchive({ directory, namespace: 'a' })
  a.append('private:owner', { id: 'one', role: 'user', text: 'Coffee秘密偏好' })
  assert.equal(a.append('private:owner', { id: 'one', role: 'user', text: '重复事件' }), false)
  assert.equal(a.recent('private:owner').length, 1)
  for (const chat of ['private:other', 'group:owner']) assert.equal(a.recall(chat, 'Coffee', { recentMessages: [] }).text, '')
  const b = createConversationArchive({ directory, namespace: 'b' })
  assert.equal(b.recall('private:owner', 'Coffee', { recentMessages: [] }).text, '')
})

test('机器人生成的经历保持assistant来源，不会转换成用户事实', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-attribution-'))
  const archive = createConversationArchive({ directory })
  archive.append('private:owner', { role: 'assistant', text: '我去过Coffee星球' })
  const found = archive.recall('private:owner', 'Coffee星球', { recentMessages: [] })
  assert.equal(found.selected[0].context[0].role, 'assistant')
  assert.equal(found.selected[0].source, 'new_conversation')
})

test('长期事实检索在范围过滤前不会从别的私聊/群聊取回内容', () => {
  const idx = buildIndex([
    { id: 'private', text: 'Coffee偏好', chatId: 'private:alice' },
    { id: 'group', text: 'Coffee群活动', chatId: 'group:g' },
    { id: 'shared', text: 'Coffee公开设定', visibility: 'shared' },
  ])
  assert.deepEqual(search(idx, 'Coffee', { chatId: 'private:bob' }).map(h => h.it.id), ['shared'])
  assert.ok(search(idx, 'Coffee', { chatId: 'private:alice' }).some(h => h.it.id === 'private'))
})

test('否定和不同聊天的相似事实不会被自动去重覆盖，重复观察不篡改事件时间', () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-fact-versions-'))
  const store = createMemoryStore({ getConfig: () => ({ memory: { recallCount: 6 } }), dsh: {}, hub: {}, log: {} })
  const first = store.add({ text: '我喜欢手冲Coffee', about: 'alice', chatId: 'private:alice' })
  const negated = store.add({ text: '我不喜欢手冲Coffee', about: 'alice', chatId: 'private:alice' })
  const other = store.add({ text: '我喜欢手冲Coffee', about: 'alice', chatId: 'group:g' })
  assert.notEqual(first.id, negated.id)
  assert.notEqual(first.id, other.id)
  const before = store.list('').find(m => m.id === first.id).at
  assert.equal(store.add({ text: '我喜欢手冲Coffee', about: 'alice', chatId: 'private:alice' }).updated, first.id)
  assert.equal(store.list('').find(m => m.id === first.id).at, before)
})

test('询问过去可以取回被更正的旧版本，询问现状只提供当前版本', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-time-'))
  process.env.AURABOT_DATA_DIR = directory
  writeFileSync(join(directory, 'memories.json'), JSON.stringify({ items: [
    { id: 'old', text: '对方以前喜欢Coffee手冲', chatId: 'private:alice', about: 'alice', importance: .8, at: Date.now()-86400_000, invalidAt: Date.now(), supersededBy: 'new' },
    { id: 'new', text: '对方现在改喝清茶', chatId: 'private:alice', about: 'alice', importance: .8, at: Date.now() },
  ] }))
  const store = createMemoryStore({ getConfig: () => ({ memory: { enabled: true, recallCount: 6 } }), dsh: {}, hub: {}, log: {} })
  const chat = { kind: 'private', userId: 'alice', chatId: 'private:alice' }
  assert.match(store.recallHint(chat, '以前喜欢Coffee吗'), /已被后续信息更正/)
  assert.doesNotMatch(store.recallHint(chat, '现在喜欢Coffee吗'), /以前喜欢Coffee/)
})
