# dsh-story-mode · 短篇小说模式

给 **DeepSeek Harness (DSH)** 的一个写作专用模式。装好之后，新建会话时模式选择器里会多出「短篇小说模式」——进去的不是编码 agent，而是一个接稿的短篇小说作者。

整套能力（模式、技能、工具）都在**一个包**里，一条命令落地。

---

## 它解决什么问题

让可测量的内容由程序负责，让需要上下文的内容由读者判断。

| 程序测量或定位 | 审读判断 |
|---|---|
| 中文字数、分场、相对已确认目标的偏离 | 场景是否有效、节奏是否合适 |
| 引号内文字比例、段落长度 | 对话是否自然、人物口吻是否可区分 |
| 重复双字组合、常见用词位置 | 修辞是否有效、心理与情绪是否冗余 |
| 人物卡字段是否非空、姓名与别名字面提及 | 新人物、专名一致性、动机与跨篇设定 |
| 稿件内容版本、原文行号 | 视角、时态、因果与必要交代 |

字面命中不代表违规，统计正常不代表故事好看。工具不再根据“我/你/他”判定视角滑移，也不依据固定对话比例评价节奏。

新写、续写、整体改稿、局部润色采用不同规模的流程。局部修改不强制新建接稿单或启动完整审读面板。

---

## 安装

```sh
dsh plugin --profile <你的 profile> add github:Furry-wucheng/dsh-story-mode
```

**就这一条。** 不需要第二步、不需要改任何配置文件。装完新建会话，模式选择器里就有「短篇小说模式」。（CLI 启动的 profile 下当场生效；桌面版若没看到，重启一次 DSH——它的 profile 组装只在启动与插件状态变更时跑，没有监听 bundles 的 watcher。）

### 它是怎么做到的

模式**住在包里**（`presets/short-story/`）。包的 `cordis.patch.yml` 在 profile 合成配置时被合并，其中用 `createRequire(ctx.baseUrl)` 在**运行时**问出本包装在哪，然后接管 `agent-presets` 那一行、把包内 `presets/` 声明为 roster 的一个根。

「包被装到哪」在发布时不可能知道，所以路径必须运行时算——这也是社区插件（如 dsh-TUI）解决同一个问题的做法。

### 卸载

```sh
dsh plugin --profile <你的 profile> remove dsh-story-mode
```

**模式与它自带的两份技能都跟着包一起走**，这两样不需要任何清理——它们从来没被复制到你家里去过。（模式住在包的 `presets/short-story/`，技能是 preset 用 `customSkillDirs` 从包内挂上去的，所以文风契约只在这个模式里可见。）

只有一件事要在卸载前确认：

```sh
dsh plugin --profile <你的 profile> exec dsh-story-mode check
```

如果它提示「默认预设指向本模式」，先清理再卸载：

```sh
dsh plugin --profile <你的 profile> exec dsh-story-mode cleanup
```

为什么要跑：如果你在设置里把「短篇小说模式」设成了**默认模式**，卸载包之后新建会话会直接以 `agent-preset/not-found` 失败——DSH 找不到默认 preset 时不会回退到 `standard`，而真正会顺手清掉这个默认值的那条路径被 `dsh plugin remove` 绕过了。这一步必须在卸载**之前**做，因为包一旦 remove，这个命令也就没了。

（`cleanup` 顺带清掉两处历史残留：v1.0.1 复制到 `<DSH_HOME>/.agent-presets/short-story` 的模式副本，以及 v1.0.1／v1.0.2 曾可选安装的 `<DSH_HOME>/skills/writing-style-contract` 副本——后者只在带 `.dsh-story-mode.json` 归属标记时才删，绝不会误伤你自己手写的同名技能。不是本包放的东西一律不动。）

### 一条命令的边界：它接管了官方那一行

`ctx.agentPresets` 这个服务只允许发布一次，所以本包**不能**另插一行——那样会和官方行冲突，只能有一方生效。所以它覆写官方 `agent-presets` 行的 `config`，保留 `default: standard` 并把本包的 `presets/` 追加为根。

**代价必须知道**：补丁按 id 覆盖 `config`。升级 DSH 之后，如果官方给这一行加了新字段，本包会静默抹掉它。对照检查：

```sh
dsh --profile <你的 profile> --dump-default-config
```

**桌面版对同一行也压了一层，而且在本包之后**：它读回合成后的 config，写成 `roots = [<dsh-agent-presets 包>/presets(system), <DSH_HOME>/.agent-presets(user)]` 加 `includeUserRoot: false`。本包没被它盖掉，靠的是本包 `config` 是**一个** `!!js` 表达式——落地后它是 `{ __jsExpr: … }` 标记，桌面那层展开会把这个标记一起带上，而 Loader 的 `interpolate()` 先看整体：`isJsExpr` 命中就整体求值返回，后加的 `roots` 被丢弃。

**这不是"稳"，是"恰好"**：如果把这一行的 config 改成"普通映射 + 内层 `!!js` 算路径"，桌面那层就会反过来盖掉 `roots`，模式会**静默消失**且没有任何报错。改这一行前请先读 `cordis.patch.yml` 里的对应段落。

`story_doctor` 会提示这项风险，但不执行官方配置比对或实际加载验证。将来若多个插件都需要追加根，这是框架层面的限制（`roots` 不是增量合并的）——届时该由 DSH 提供追加语义，而不是每个插件各自覆写。

### 验证安装

下面的命令只检查卸载残留，不证明模式已经加载成功：

```sh
dsh plugin --profile <你的 profile> exec dsh-story-mode check
```

安装验证请在新会话里让 agent 调用 `story_doctor` —— 它会逐项报告：包是否进了 bundles、`package.json` 是否可解析（带 BOM 会让 DSH 读不出 `dsh.bundle`）、patch 是否接管了那一行、包内模式目录是否满足静态发现条件、文风契约是否已挂进 preset，以及卸载前需要注意的两处残留（默认预设 / 旧安装副本）。

### 其他安装方式

```sh
# 全局安装
pnpm add -g github:Furry-wucheng/dsh-story-mode

# 从源码目录直接开发（不装进 profile）
git clone https://github.com/Furry-wucheng/dsh-story-mode
cd dsh-story-mode && pnpm pack        # 得到一个 tgz
dsh plugin --profile <你的 profile> add ./dsh-story-mode-1.1.1.tgz
```

### 升级

```sh
dsh plugin --profile <你的 profile> add github:Furry-wucheng/dsh-story-mode
```

模式与两份技能都跟着更新——它们都住在包里，没有任何需要手动刷新的副本。

## 用它

直接说明要新写、续写、改整篇还是改某一处。开工前它会先把真正影响成稿的选择问清——篇幅档位、视角与时态、调性禁忌、结局倾向——**一次问完**，你提过的就不再问；你说“你决定”它就自己定并说明取的是什么。已给过的字数、风格和结构要求直接沿用，不重复追问。

- **新写完整故事**：先问清缺的约束，给简洁方案；按授权成稿，先冷读，再修订，按需专项审读，最后由一位全新读者盲读新版。
- **续写**：沿用相关前文和有效设定，只确认实质性的新选择。连载审读默认允许阅读已发布前文。
- **整体改稿**：先读现稿，按问题选择结构、阅读体验或文风审读，不为套模板重建全部文件。
- **局部润色**：读指定片段及必要上下文，修改后检查接缝和信息，简短交付。不会自动扩大为整篇改写。
- **只要评价**：只给意见，不改正文。

篇幅档位是参考：微型 3k–5k、标准短篇 5k–10k、中短篇 10k–20k、系列每篇 3k–10k。作者给出具体字数时直接采用，也支持范围之外的要求。

### 故事资产

沿用现有目录和文件名。新故事通常用 brief.md 保存有效约束、outline.md 保存场景计划、draft.md 保存正文。已有短稿和局部任务不强制补建规划文件。

跨篇设定复杂时再维护 bible.md；时间关系复杂时使用 timeline.md；专名较多时使用 glossary.md。多篇正文可放 draft/ 下，一篇一个文件。工具与审读逐篇运行，不拼出临时总稿。

人物卡示例：

~~~markdown
## 林远（别名：阿远）
- 身份：夜班司机
- 动机：找到失联的妹妹
- 关系：林青的哥哥
~~~

## 四个工具

全部只读。正文和设定的修改走宿主的常规文件工具。

| 工具 | 实际能力与边界 |
|---|---|
| story_wordcount | 字数、按分隔符或标题分场、目标偏离、段落长度、引号内比例、引号外重复双字组合；不评价节奏好坏 |
| story_lint | 引号外用词线索，带原文行号和版本；不判视角、时态、情绪冗余或“AI 文风”，也不要求按命中删改 |
| story_bible | 校验人物卡必填字段非空、姓名及别名字面提及、术语清单；不识别全部新人物或判断设定合理性 |
| story_doctor | 静态安装自检与残留提示；不能代替 DSH 实际加载和子代理运行验证 |

### 按大纲目标统计

~~~json
{"path":"故事/draft.md","sceneTargets":"1000,3000"}
~~~

sceneTargets 是按场景顺序排列的正整数字数。工具计算（实际字数 − 目标字数）/ 目标字数，不按场景均分。
逐场成稿时可传包含后续未写场景的完整列表；已写场景必须都有目标。没有计划目标时省略参数，只看分布。
配置 sceneDriftPercent 表示相对目标的偏离百分比，默认 15。旧 dialogueLowPercent / dialogueHighPercent 已不再使用。

引号内比例仅是对话的近似量，包含引用，不含无引号台词。重复项是未经分词的双字组合，不自动构成用词错误。
标题与开头的完整元数据块不计入正文；报告行号仍对应源文件。

### 用词线索与人物检查

story_lint 的 only 可筛选：template-simile、psychological-summary、emotion-explained、dialogue-tag-overuse、emotion-adverb-tag、ai-rhythm、cheap-adverb。这些旧规则 id 保持兼容，报告现在只表示待阅读的线索。旧 pov 参数和 only: pov-drift 仍接受，但不执行人称检查，会说明判断已移交审读员。

story_bible 的“缺卡候选”仅来自 bible 的“已知事实”清单里，在正文出现至少两次、却未建卡的条目。正文中新出现但未进清单的名字不会自动识别；人物、指代与拼写一致性要由审读员核对。

## 审读流程

完整新稿或整体修订一般是：初次冷读 → 主代理修改 → 复核（同一位读者）→ 按需专项审读 → 修改 → 最终盲读（新读者）。
局部任务只做对应范围的检查；默认规模只有两位读者，不要求每次都派四路。

**审读员是可复用的持久子代理。** 每个角色派发一次就拿到它的 childId；改稿后的复核用 `send_message` 交给**同一位**读者——它保留着上一版的阅读和自己的报告，只需要回答“这次改了什么、你上次那几条还成不成立”，不必重读全文，前缀命中缓存。只有最终盲读另起一位新读者：独立性不能复用。派发时不要传 `run_in_background: false`，那会退化成一次性会话，后续消息送不到。

这套行为由 preset 的 `backgroundMode: continuable` 加 `send_message` / `list_agents` 两行工具提供；`story_doctor` 会静态检查它们还在不在。

| 角色 | 可以读取的材料 |
|---|---|
| B1 冷读者 | 本篇正文；连续阅读模式可读已发布前文正文，不读大纲、设定、作者摘要或旧问题 |
| B2 故事逻辑 | 正文、作者有效要求、已有大纲/设定/时间线、必要前文 |
| B3 阅读体验 | 正文与获准前文；不预先看 B1 报告，独立判断 |
| B4 文风执行 | 正文、作者要求、文风契约；通读后看同版本 lint 线索 |

每次派发记录正文路径和工具给出的内容版本。审读期间暂停修改；回收后核对版本。
问题位置采用“场景 + 原文短引 + 行号”，主代理追踪改稿后的对应位置。不同版本的段落号不能直接交叉判断。

**最终盲读使用全新读者，只看最新正文。** 旧问题是否解决由主代理在报告返回后对照。读者的困惑是需要核实的证据，也可能是合理悬念，不自动要求补背景。

审读员只读、不修改、不再次委派；目前这是提示词约束，通用 subagent 仍继承宿主工具，**不代表代码层实现了只读权限隔离**。宿主支持额外权限限制时应启用。独立审读无法运行时如实说明，不虚报验收。

完整模板在 presets/short-story/skills/short-story/references/review-panel.md。

---

## 包结构

```
dsh-story-mode/
  cordis.patch.yml                  接管 agent-presets 行，把包内 presets/ 声明为 roster 的根
  presets/short-story/              模式本身：agent.cordis.yml + 元数据 + 写作流程技能
    skills/short-story/             按任务规模选择流程 + references/review-panel.md（审读模板）
  lib/index.js                      主入口：写作工具
  lib/doctor.js                     独立入口 dsh-story-mode/doctor：只注册 story_doctor
  lib/tool-kit.js                   零依赖的工具构造器与参数校验（两个入口共用）
  skills/writing-style-contract/    文风契约（由 preset 挂进模式，只在这个模式里可见）
  bin/cli.mjs                       check / cleanup（不安装任何东西，只做卸载前清理）
  scripts/cleanup.mjs               实际干活的那份
```

两个入口是 `exports` 子路径实现的同包多入口。`./doctor` 可以单独挂到**任何**模式里做诊断（例如创造模式），不必连带加载三个写作工具。

---

## 已知约束与设计取舍

这些都是查过框架源码、并且踩过之后才写下来的：

- **审读员是 `continuable` 子代理，不是一次性调用。** 一次性模式（v1.1.0 及以前）下每轮复核都要再派一位读者，把同一篇正文重新从头读一遍；可复用模式下复核走 `send_message`，子代理带着上一版正文的阅读和自己的报告继续。**坑**：可复用模式里只有后台调用会产生持久 child，前台分支走的是 `subagents.start()`，拿不到 childId——所以技能与审读面板都明令派审读员时不要传 `run_in_background: false`。
- **写作模式故意不开 `subagent_fork`。** fork 继承主代理的全部上下文（大纲、写作推理、修改理由）；读者看过作者的底牌之后，“我没看懂”就不再是读者证据。审读员也因此不开子级模型选择，一律与主代理同路由。
- **技能根由 preset 自己声明，所以文风契约只在这个模式里生效。** 写作流程技能与文风契约分别是包内的 `presets/short-story/skills/` 与 `skills/`，都以「preset 文件所在目录」为基准解析（`!!js` 里的 `baseUrl`），注册落进本 preset 那一层，所以模式、流程技能、文风契约三者永远同进同出。它**故意不**放进 `<DSH_HOME>/skills`：那是用户根（rank 400），而每个 preset 自己挂的 skill-filesystem 实例都会扫它（`includeDefaultRoots` 默认 true）——放进去等于让它出现在所有模式里，包括编码会话，而它只属于写作模式。
- **写作模式保留了搜索工具（`glob` / `grep`）。** shell、计划模式、后台任务、工作流、多级委派都拆掉了，但"找"不能拆：系列连载里核对名字与细节靠搜，不靠通读。这一行要注意 `sampleOverCapGlobResults` 在 framework 侧是**必填**配置（`z.boolean().required()`），漏了它整个 preset 会挂不上。
- **`ctx.agentPresets` 只允许发布一次**，所以一个插件**不能**只"追加自己的 roster 行"——官方行几乎总是存在（web-app bundle 提供它），两行不能共存。注入根就必须接管那一行，代价见上面「一条命令的边界」。
- **`roots` 是整体替换而非增量合并。** 所以本包接管那一行时会把它自己的根写全；多个插件都要追加根时，这是框架层面的限制。
- **根下的 `<id>` 条目必须是真实目录。** roster 的 `scanRoot` 用 `readdir().isDirectory()` 判定，**不跟随符号链接**。Windows 上 Node 把 junction 报成符号链接，于是链接形式的预设会被**静默跳过**，而 `stat()` 读文件却完全正常——本包早期版本正是栽在这里。（技能侧相反：`dsh-skill-filesystem` 会跟随链接一级。）
- **`!!js` 后面是折叠标量，整段代码会压成一行。** 所以那段 JavaScript 里不能有 `//` 行注释（一个就吃掉后面全部），也不能靠自动分号插入。这两条都是实测踩出来的。
- **`createRequire` 的锚点必须按文件 URL 给。** 给它一个不带尾斜杠的目录路径，Node 会把该目录当成文件解析，直接 MODULE_NOT_FOUND。
- **`package.json` 不能有 BOM。** 带 BOM 会让 `JSON.parse` 失败，DSH 因此读不出 `dsh.bundle` 声明，`dsh plugin add` 不会把包加进 profile 的 bundles，patch 永远不生效——表现为"装好了但模式不出现"。这个坑本包也踩过一次，`story_doctor` 里有常驻检查（`package.json 无 BOM` 那一项）。
- **preset 行不能用 `!!js` 动态算路径。** 发现阶段确实支持 `!!js`，但紧随其后的形状检查要求每行的 `name` 是**字符串**；`!!js` 解析出来是对象，整份组成会被判为 broken。
- **preset 行不能用裸包名**（从 harness 解析，到不了用户目录），所以组成里用相对引用 `../../lib/index.js`——以组合文件所在目录为基准，因此**没有任何机器相关的绝对路径**。
- **本包零运行时依赖**（连 `schemastery` 都没有）。ESM 的解析基准是加载入口的父路径，所以插件若 `import` 任何 `@deepseek-ai/*` 包就必须自带 `node_modules`；它什么都不 import，于是任何布局下都能加载。**改代码时不要引入裸导入**，否则上面那条相对引用会失效。

### 安装会改动你的 home 目录吗

**不会。** `dsh plugin add` 只写 profile 的 `package.json`、`node_modules` 与 patch 层：模式住在 profile 的 `node_modules` 里（也就是 pnpm 装包的地方），技能由 preset 从包内挂载。`<DSH_HOME>/skills/` 与 `<DSH_HOME>/.agent-presets/` 都不碰，也没有需要用户去批准的构建脚本（pnpm 默认就会拦截依赖的生命周期脚本，本包不依赖它）。

`cleanup` 是唯一会写你 home 的命令，而且只**删**本包自己留下的东西：指向本模式的默认预设、v1.0.1 的模式副本、带 `.dsh-story-mode.json` 归属标记的技能副本。不是本包放的一律不动。

**注意**：v1.0.1 把模式**复制**进 `<DSH_HOME>/.agent-presets/short-story`。那份副本会和 patch 声明的根撞 id，roster 只会认先扫到的那一个——留下过期的副本会让"改了包内文件但模式没变"发生。`check` 会报出来，`cleanup` 会清掉。

---

## 文风契约

skills/writing-style-contract/SKILL.md 提供默认文风：克制、自然、具体。作者风格要求优先，不把所有作品改成同一种声音。

契约内附修改前后与保留示例，并展示同一问题在不同场景需要下的长短两类有效写法：删掉重复解释，也可以继续展开动作、感知和等待。默认约束仍然严格，例外必须有原文依据，不能只说“服务叙事”就放行；示例不作为仿写素材，不以缩短篇幅为统一目标。

修辞、心理、台词、动作和直接交代都按上下文判断；允许增写、删减或保留，不设最低删除百分比。
必要信息要在读者需要时可得；合理推断和有效留白可以保留，不要求所有专名首次出现就讲完背景。

视角检查交给审读员：区分叙述者、人物台词、内心引语与面向读者的称呼，指出具体的认知越界，不从人称字样下结论。

## 开发验证

~~~sh
npm test
~~~

回归测试覆盖分场、引号统计、真实配额、用词线索、人物卡和卸载检查。测试只使用内存稿件和临时 DSH 主目录，不修改真实用户设置。
npm run check 与 CLI check 都是卸载残留检查，不是单元测试或完整安装验证。

---

## License

MIT
