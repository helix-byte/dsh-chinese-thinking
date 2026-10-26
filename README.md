# dsh-chinese-thinking

> DSH（DeepSeek Harness）插件：用五层冗余机制强制模型使用中文进行内部推理。

## 解决什么问题

模型在给出中文回答时，内部 `reasoning`（思维链）经常仍以英文进行，导致：

- 中英混杂，术语前后不一致；
- 推理深度与中文表达脱节；
- 工具调用前后的分析退回英文。

只写一句"请用中文思考"很容易被稀释掉，尤其在一轮对话的中后段。本插件把这条约束拆成五个互相冗余的注入点，任一层失效仍有其余四层兜底。

## 五层机制

| 层 | 注入位置 | `order` | 作用 |
|---|---|---:|---|
| Layer 1 | 系统提示节 `language:chinese-reasoning` | -200 | 在所有系统提示节之前，先立规矩 |
| Layer 2 | 运行时上下文（独立于系统提示的历史消息层） | -200 | 不进系统提示，改为运行时上下文，避免被后续拼接稀释 |
| Layer 3 | `agent/pre-step` 每步骤消息注入 | — | 每一步都追加一条语言提醒，并保留下游 `decision` 的其余字段 |
| Layer 4 | 工具使用指导 `language:tool-guidance` | 150 | 覆盖工具调用前的分析、调用中的决策、调用后的解读 |
| Layer 5 | 推理语言后验检测 + 修正注入 | — | 读取上一步 `reasoning`，中文占比不足 20% 时注入修正指令 |

### 后验检测的判据

从 `session.snapshotEvents()` 里回溯最近的 `assistant/message`，取其 `reasoning` 块文本，统计 CJK 统一表意文字（U+4E00 ~ U+9FFF）的字符占比：

```
chineseChars / text.length >= 0.2
```

低于阈值即判定为非中文推理，下一步注入"语言修正"而非普通"语言提醒"。

## 安装

本插件以 DSH bundle patch 的方式挂载。`cordis.patch.yml` 定义插入点：

```yaml
- insert:
    - id: chinese-thinking
      name: '@skyline/dsh-chinese-thinking'
```

应用顺序为 `dsh-base → dsh-web-app → 本层 → profile 自己的 cordis.patch.yml`。

将本目录放入 `dsh-plugins/`，并在目标 profile 的 `cordis.yml` / `cordis.patch.yml` 中引用即可。

## 兼容性

- 依赖 `@deepseek-ai/cordis` ^4.0.0
- **会话格式 v4 的消息 `source` 约定**：`kind` 必须是非空字符串，且不得使用保留值 `plugin`。V3 时代的 `{ kind: 'plugin', plugin: '<name>' }` 包装在 v4 中会在持久化准入阶段抛 `format v4 message requires a producer-owned source kind`，导致整轮失败。本插件使用命名空间 `plugin:chinese-thinking`。
- 旧代码中常用的 `agent.session.events` 并不存在，公开读取入口是 `session.snapshotEvents()`。本插件对两者都做了兼容。

## 已知限制

- 后验检测只覆盖**上一步**的 `reasoning`，无法干预模型内部实际计算。
- 注入消息以 `user` 角色下发，会在会话里产生额外的消息条目（`id` 前缀 `cthnk-`）。
- 中文字符占比是粗略启发式，代码块、专有名词占比高的推理可能被误判为"非中文"，从而触发不必要的修正。

## 许可

尚未指定（License: TBD）。
