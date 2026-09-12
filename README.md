# dsh-story-mode · 短篇小说模式

给 **DeepSeek Harness (DSH)** 的一个写作专用模式。装好之后，新建会话时模式选择器里会多出「短篇小说模式」——进去的不是编码 agent，而是一个接稿的短篇小说作者。

整套能力（模式、技能、工具）都在**一个包**里，一条命令落地。

---

## 它解决什么问题

写代码时有编译器、测试、类型检查替你验证；写小说时唯一能验证稿件的东西是**程序**，不是模型的直觉。这个模式把"程序能判定的事"从模型判断里拿出来：

| 交给确定性代码 | 交给模型 |
|---|---|
| 中文字数（CJK 逐字口径） | 结构、节奏、人物 |
| 场景配额与偏离 | 语气、视角执行 |
| 对话 / 叙述比例 | 取舍与判断 |
| 专名拼写、人物卡缺字段 | 改稿决策 |
| 模板化比喻、心理总结、视角滑移 | 哪一处该留 |

外加一条流程纪律：**先出接稿单与节拍表等作者确认，再落笔**；写完必须按文风契约自查删减一遍。

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

`story_doctor` 也会替你盯这一点。将来若多个插件都需要追加根，这是框架层面的限制（`roots` 不是增量合并的）——届时该由 DSH 提供追加语义，而不是每个插件各自覆写。

### 验证安装

```sh
dsh plugin --profile <你的 profile> exec dsh-story-mode check
```

或者在新会话里让 agent 调用 `story_doctor` —— 它会逐项报告：包是否进了 bundles、`package.json` 是否可解析（带 BOM 会让 DSH 读不出 `dsh.bundle`）、patch 是否接管了那一行、包内模式是否通过框架自己的发现判定、文风契约是否已挂进 preset，以及卸载前需要注意的两处残留（默认预设 / 旧安装副本）。

### 其他安装方式

```sh
# 全局安装
pnpm add -g github:Furry-wucheng/dsh-story-mode

# 从源码目录直接开发（不装进 profile）
git clone https://github.com/Furry-wucheng/dsh-story-mode
cd dsh-story-mode && pnpm pack        # 得到一个 tgz
dsh plugin --profile <你的 profile> add ./dsh-story-mode-1.0.3.tgz
```

### 升级

```sh
dsh plugin --profile <你的 profile> add github:Furry-wucheng/dsh-story-mode
```

模式与两份技能都跟着更新——它们都住在包里，没有任何需要手动刷新的副本。

## 用它

进去之后直接说要写什么就行。正常流程是：

1. **识别目标形态** —— 单篇精修，还是系列连载里的一篇（判据从你的措辞和已有稿件读）
2. **选篇幅档位** —— 微型 1k–3k / 标准短篇 3k–8k / 中短篇 8k–20k / 系列每篇 3k–10k
3. **出接稿单与节拍表** —— 等你确认。结构问题在写之前修，成本是写之后的十分之一
4. **成稿** —— 按配额写，每场核对字数
5. **改稿两遍** —— 先结构，再句子；然后跑 `story_lint` 逐项处理

### 故事资产结构

一个故事一个目录，按形态取用（单篇精修只用前三个，系列才需要全部）：

```
<story>/
  brief.md        接稿单：形态 / 体裁 / 视角 / 时态 / 篇幅档位 / 调性 / 禁忌 / 结局倾向
  outline.md      节拍表：场景序、每场目标与冲突、字数配额、结尾钩子
  draft.md        正文（主稿件，交付物）
  bible.md        设定圣经：人物卡、关系、动机、已知事实
  timeline.md     时间线（系列或非线性叙事才用）
  glossary.md     专有名词表（系列才用）
```

`bible.md` 是这个模式的杠杆：它把设定从对话记忆搬到磁盘上。改到第八轮时读一次它就能恢复全部约束，不用重新消化整段聊天。

---

## 四个工具

全部**只读**。稿件与设定圣经的修改走你常规的文件工具，所以写入仍然经过宿主的文件策略与沙箱——这个包不自己发明第二条写入通道。

| 工具 | 做什么 |
|---|---|
| `story_wordcount` | 口径字数、场景配额与偏离、对话占比、最长段落、**同一段内**的重复双字词 |
| `story_lint` | 文风契约的八条确定性检查（模板化比喻、心理总结、解释情绪、提示语过密、情绪修饰提示语、视角滑移、AI 节奏、填充副词）。提示语只在一行确有引号时才计；视角只读引号外的叙述，传 `pov`（接稿单里的视角）时严判人称混用 |
| `story_bible` | 解析人物卡（别名、缺 身份/动机/关系 字段）、跨文件提及次数、正文提到但没卡的名字、术语表 |
| `story_doctor` | 安装自检：模式是否落地、内容是否过期、`roster` 能否发现它 |

---

## 包结构

```
dsh-story-mode/
  cordis.patch.yml                  接管 agent-presets 行，把包内 presets/ 声明为 roster 的根
  presets/short-story/              模式本身：agent.cordis.yml + 元数据 + 写作流程技能
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

`skills/writing-style-contract/SKILL.md` 是这个模式默认执行的写作标准，十二条：默认叙事风格、少用形容词与副词、禁止廉价比喻、对话写法、少用"他说+修饰语"、不解释已能看出的情绪、不主动总结心理、描写只留有用细节、不追求每句好看、避免 AI 节奏，以及交稿前的自查删减。

它只在这个模式里可见——不会出现在编码会话的技能目录里。作者在 `brief.md` 里给的风格要求覆盖它。

---

## License

MIT