# 中断续接（dsh-thinking-resume）

长请求跑到一半断流，DSH 会重试——但重试请求按会话表面历史重建，失败那一次已经收到的流（思考、正文、工具调用草稿）不会回到模型眼前，模型只能从零再来一遍。

这个插件在请求失败的那一刻，把刚失败的 `assistant/attempt` 里保存的流式输出整理成一条上下文消息写回会话，随后的重试请求就会带着断点继续。内核重启或隔天接着聊时，插件也会把最后一段没被接续的失败输出补进新的 turn。

## 安装

插件是 DSH 的 Host bundle，装进要用的 profile：

```sh
dsh plugin --profile <profile名> add github:lakitu12/dsh-thinking-resume
```

`dsh plugin` 识别到包里的 bundle patch 后会自动把它写进该 profile 的 `dsh.profile.bundles`；重启 DSH 生效。

本地开发直接 link 工作目录：

```sh
dsh plugin --profile <profile名> add link:/path/to/dsh-thinking-resume
```

## 恢复哪些内容

| 内容 | 说明 |
|---|---|
| 内部思考（reasoning） | 中断前已产生的思考原文 |
| 已输出的正文（text） | 模型已经写出、但还没提交到会话表面的文字 |
| 工具调用草稿 | 已发起但未执行的调用（失败的那次请求不会执行任何工具） |

三节按流的顺序排列，只在存在内容时出现。离中断点越近的内容越重要：超长时从旧到新截断，工具草稿与正文优先完整保留，思考保留尾部。

## 行为

- 只在请求以 `error` 结束时介入。用户主动取消不用管：内核自己会把已经流出的内容冻结成一条被中断的助手消息落进会话，本来就不会丢。
- 失败后按输出总长（思考 + 正文 + 工具参数）分两种处理：够 `minChars` 就续接（模型接着写），不够但够 `keepMinChars` 就只留存（给用户回看，不要求模型接话）。`excludeCodes` 里的失败一律只留存。
- 注入的消息在界面里是一张上下文卡片（来源标记 `thinking-resume`），不是用户气泡；续接模式下它同时是模型续写的断点，留存模式下只是背景。
- 同一步失败多次时，每次只补本次 attempt 新增的那段输出，不会把旧内容重复堆叠。
- 恢复消息是普通会话事件，会随会话持久化，后续轮次继续保留（可被 compaction 正常压缩）。

## 失败前的内容，用户也看得到

这段输出不是只喂给模型：它留在对话里，用户随时能读到。续接和留存是同一张卡片，区别只在末尾那句是"接着写"还是"只作背景"。

- 卡片折叠时的那一行写明发生了什么——错误码、思考/正文/工具草稿各有多少、生成断在哪里（例如 `输出中断（TRANSPORT）：思考 3.2k 字 · 正文 180 字，断在「…」`）。
- 展开卡片就是失败前的原文：思考、已写出的正文、没执行成的工具调用各成一节。这段话是模型和用户共读的同一份文本，所以措辞两边都能读，只有末尾一句是给模型的续写指令。
- 这一行的摘要只存在于会话事件的 `source` 里，不进入模型输入，纯粹给用户看。

DSH 的 Chat 里，只有上下文卡片能承载"不进用户气泡、但进模型上下文"的内容，所以它不会伪装成助手回复或思考行；看全文点开卡片即可。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖 `thinking-resume` 这一行：

```yaml
- id: thinking-resume
  config:
    enabled: true          # 总开关
    minChars: 200          # 达到此长度才续接（让模型接着写）
    keepMinChars: 0        # 低于 minChars 但达到此长度则只留存给用户看，0 = 有内容就留
    keepOnExcluded: true   # excludeCodes 里的失败不续接但仍留存；false = 直接丢弃
    maxInjectChars: 0      # 单次注入上限，0 = 不限；超长时优先保住正文与工具草稿
    recoverOnResume: true  # 失败后用户重新发消息时，补上最后一段未接续的输出
    excludeCodes:          # 不值得续接的错误（鉴权、请求非法、超上下文等）
      - AUTH
      - INVALID_REQUEST
      - CONTEXT_WINDOW_EXCEEDED
    logLevel: info         # silent 关闭注入日志
```

## 注意

- 注入内容会占用输入 token；几十分钟的思考可能很长，用 `maxInjectChars` 限制。
- 模型看到的仍然是一段"引用文本"，不是原生 thinking 回传；提示词已明确它不是用户指令。
- 需要挂载 provider 自带的请求重试（`dsh-llm-retry` 或 `dsh-llm-retry-settings`）才有"重试"可续；没有重试时，恢复内容会留到用户下一次发言。

## 测试

```sh
node test/run.mjs
```

测试在假的 Session 上覆盖注入、错误码排除、短输出、多次失败、pre-step 恢复、正文与工具草稿、预算截断等行为。

`test/fake-provider/` 是端到端验证用的临时 provider：第一次请求发出思考、正文和工具草稿后以 `TRANSPORT` 失败，之后的请求成功，并把每次请求里是否有续接消息写进 `/tmp/fake-resume-provider.log`。需要时把它一起 link 进临时 profile。

## 文件

- `index.js` — Host 插件：`agent/request-error` 与 `agent/pre-step` 两个监听器。
- `cordis.patch.yml` — bundle 安装时插入的 Loader 行。
- `locale/` — 插件列表里的标题与说明。
- `test/run.mjs` — 用假 Session 跑的行为测试。
- `test/fake-provider/` — 端到端验证用的临时 provider。

## 许可

[MIT](LICENSE)