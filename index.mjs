/**
 * Chinese Thinking (Scheme E)
 *
 * 五层冗余强制中文推理：
 *   Layer 1: 系统提示节 (order -200)
 *   Layer 2: 运行时上下文 (独立于系统提示的历史消息层)
 *   Layer 3: 每步骤消息注入 (agent/pre-step)
 *   Layer 4: 工具使用指导 (order 150)
 *   Layer 5: 推理语言后验检测 + 修正注入
 *
 * 会话格式 v4 的消息来源 (source) 约定：
 *   kind 必须是非空字符串，且不得使用保留值 'plugin'。V3 时代的
 *   { kind: 'plugin', plugin: '<name>' } 包装在 v4 中已被淘汰：写入时会在
 *   持久化准入阶段抛 "format v4 message requires a producer-owned source
 *   kind"，导致整轮直接失败（本轮运行失败）。第三方插件沿用 V3→V4 迁移器
 *   的命名空间约定，即 kind = 'plugin:<包名>'。
 */

/** 本插件注入消息的生产方归属 kind（第三方命名空间，避免冒用第一方 kind）。 */
const SOURCE_KIND = 'plugin:chinese-thinking'

export default {
  name: 'chinese-thinking',
  inject: ['systemPrompt'],
  apply(ctx) {
    // ════════════════════════════════════════════════════════════════
    // Layer 1: 系统提示节 (order -200, 位于所有节之前)
    // ════════════════════════════════════════════════════════════════
    ctx.systemPrompt.section({
      name: 'language:chinese-reasoning',
      order: -200,
      text: '【推理语言要求】你必须使用中文思考和推理！你的所有链式思维内容必须是中文！\n[Reasoning Language] You MUST reason in Chinese! Your reasoning content must always be in Chinese!',
    })

    // ════════════════════════════════════════════════════════════════
    // Layer 2: 运行时上下文 (独立于系统提示的历史消息层)
    // ════════════════════════════════════════════════════════════════
    ctx.systemPrompt.context({
      name: 'language:chinese-reasoning',
      order: -200,
      text: '【最终提醒】再次强调：你的思考/推理过程必须是中文。无论上下文是什么语言，你的内部思考必须用中文。\n[Final Reminder] Your reasoning / chain of thought MUST be in Chinese, regardless of the language used in the conversation.',
    })

    // ════════════════════════════════════════════════════════════════
    // Layer 4: 工具使用指导 (order 150, 工具指导范围 100-199)
    // ════════════════════════════════════════════════════════════════
    ctx.systemPrompt.section({
      name: 'language:tool-guidance',
      order: 150,
      text: '工具使用要求：在所有工具调用过程中，保持中文内部推理。调用前的分析、调用中的决策、调用后的结果解读，都必须使用中文思考。',
    })

    // ════════════════════════════════════════════════════════════════
    // Layer 3 + 5: 每步骤消息注入 + 推理语言后验检测
    // ════════════════════════════════════════════════════════════════
    var msgCounter = 0
    function nextMsgId() {
      return 'cthnk-' + String(Date.now()) + '-' + String(++msgCounter)
    }

    // 检测字符串中是否包含足够的中文字符 (CJK 统一表意文字)
    function hasSufficientChinese(text) {
      if (typeof text !== 'string' || text.length === 0) return false
      var chineseChars = 0
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i)
        // CJK Unified Ideographs: U+4E00 ~ U+9FFF
        if (code >= 0x4E00 && code <= 0x9FFF) chineseChars++
      }
      return (chineseChars / text.length) >= 0.2
    }

    // 会话日志的公开读取入口是 session.snapshotEvents()；
    // agent.session.events 并不存在（旧代码因此永远读不到上一步推理）。
    function sessionEvents(session) {
      if (!session) return null
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      if (Array.isArray(session.events)) return session.events
      return null
    }

    // 从 session events 中查找上一步的推理 (reasoning) 文本
    function getPreviousReasoning(agent) {
      try {
        var events = sessionEvents(agent && agent.session)
        if (!events) return null
        // 从后往前遍历，找最近的 assistant/message
        for (var i = events.length - 1; i >= 0; i--) {
          var evt = events[i]
          if (!evt || evt.type !== 'assistant/message') continue
          var msg = evt.data && evt.data.message
          if (msg && Array.isArray(msg.content)) {
            for (var j = 0; j < msg.content.length; j++) {
              var block = msg.content[j]
              if (block && block.type === 'reasoning' && typeof block.text === 'string') {
                return block.text
              }
            }
          }
          // 有 assistant message 但没有 reasoning block -> 不需要修正
          return null
        }
      } catch (_) {
        // session 读取可能在不安全的时间点失败，静默忽略
      }
      return null
    }

    ctx.on('agent/pre-step', async function(payload, next) {
      var agent = payload.agent
      var step = payload.step
      var decision = await next()
      if (decision.kind === 'reject' || !Array.isArray(decision.messages) || decision.messages.length === 0) {
        return decision
      }

      // Layer 5: 检查上一步推理的语言
      var needsCorrection = false
      if (step > 1) {
        var prevReasoning = getPreviousReasoning(agent)
        if (prevReasoning !== null && !hasSufficientChinese(prevReasoning)) {
          needsCorrection = true
          console.log('[chinese-thinking] 检测到上一步推理非中文，将在本轮注入修正指令')
        }
      }

      // Layer 3: 构造语言提醒/修正消息
      var reminderText = needsCorrection
        ? '【语言修正】上一步的推理（reasoning）中检测到非中文内容。请务必使用中文进行内部思考。所有思维链必须用中文书写。请用中文重新分析当前情况。'
        : '【语言提醒】本步骤中，请确保你的所有内部推理（chain of thought / 思维链）使用中文书写。'

      var reminder = {
        id: nextMsgId(),
        role: 'user',
        content: [{ type: 'text', text: reminderText }],
        // 生产方归属：非空且不得为保留值 'plugin'，否则持久化准入直接报错。
        source: {
          kind: SOURCE_KIND,
          form: 'snapshot',
          sections: [{ name: 'chinese-thinking', text: reminderText }],
        },
      }

      // 保留下游 decision 的其余字段（例如 startsRequestSeries），
      // 并按第一方约定把注入的上下文排在已领取消息之后。
      return {
        ...decision,
        messages: decision.messages.concat([reminder]),
      }
    })
  },
}
