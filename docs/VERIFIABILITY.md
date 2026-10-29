# VERIFIABILITY — dsh-agents 对外宣称数字的可复核总表

> 目的：本仓对外宣称的数字散落在 README / ARCHITECTURE / CHANGELOG / 工具描述 / docs 里，
> 每条的可复核路径此前**从未集中登记** —— 外部评审者无法判断哪条是实测、哪条是估算、哪条已过期。
> 本文件把全部宣称数字登记成五列固定表：`#` / `断言` / `来源（文档:节或行）` / `证据（数值/位置）` / `复现路径（可执行命令）`。
>
> **口径纪律（本表最重要的一条）**：每条断言二选一标口径 ——
> `实测读数：<值>`（附可执行命令，该值即**当次真跑**的输出）或 `估算依据：<...>`（说明外推来源）。
> **估算绝不写成实测**。
>
> 复现路径一律是**能真跑的命令**（`node …` / `git …` / `npm …`），不接受「见代码」「参考文档」这类伪路径。
> 表单元格内若含 shell 管道，一律写作转义形态 `\|`（markdown 表格纪律），执行时还原为真实管道。
>
> 矩阵由 `tools/verifiability-check.mjs` 机检（V1 条数 / V2 五列与可执行形态 / V3 口径 /
> V4 引用文件存在 / V5 零命中防护 + 阳性对照；`--execute` 追加 X1 逐条真跑核对读数）。
>
> **测量时点**：`master@880df3c` 工作树，2026-10-29 13:5x，Node v24.13.1，Windows + PowerShell 5.1。
> 全部读数为该时点实测；其中 16 条在 `--execute` 模式下逐条真跑复验（命令 + 输出比对，见报告）。
>
> **两类时点必须分清**（本表最容易踩的坑）：
> - **代码/工作树派生数字**（角色表、catalog 码点、目录件数、测试解析结果）由 `node …` 读**当前工作树**算出。
> - **历史时点断言**（`docs/design-principles.md` 的 36 文件 / 27 处时钟口径）必须在复现命令里
>   钉死 commit `6d0f71d` 复算 —— 当前树 `lib/` 已是 42 个 `.js`、时钟命中 37 处，直接读当前树会得到与文档不符的数。

---

## README.md（12 断言）

| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |
|---|---|---|---|---|
| R1 | 专职角色共 23 个 | README.md:3「23 个专职角色」；README.md:117「合计 … = 23 个角色」 | 实测读数：23 | node --input-type=module -e "import{ROLES}from'./lib/roles.js';console.log(ROLES.length)" |
| R2 | 三条泳道 build 10 · review 6 · domain 7 | README.md:45「build（构建与分析 10）· review（评审与质量闸门 6）· domain（领域专家 7）」 | 实测读数：10/6/7 | node --input-type=module -e "import{ROLES}from'./lib/roles.js';const c={build:0,review:0,domain:0};for(const r of ROLES)c[r.lane]++;console.log(c.build+'/'+c.review+'/'+c.domain)" |
| R3 | 工作流技能 25 件（25 个 SKILL.md = 25 个技能目录） | README.md:50「25 件工作流技能（口径：skills/ 下 25 个 SKILL.md = 25 个技能目录）」；README.md:151 | 实测读数：25/25 | node --input-type=module -e "import{readdirSync}from'node:fs';const d=readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory());console.log(d.length+'/'+d.filter(x=>readdirSync('skills/'+x.name).includes('SKILL.md')).length)" |
| R4 | skills/ 目录下共 29 个文件（含 README.md、replica-map.json、2 份 references） | README.md:151「目录下共 29 个文件」；ARCHITECTURE.md:198「在盘 29 个文件」 | 实测读数：29 | node --input-type=module -e "import{readdirSync}from'node:fs';const w=d=>{let n=0;for(const e of readdirSync(d,{withFileTypes:true}))n+=e.isDirectory()?w(d+'/'+e.name):1;return n};console.log(w('skills'))" |
| R5 | 评审清单 11 份（语言 7 + 专项 4） | README.md:52「11 份评审清单」；README.md:297「11 份评审清单（语言 7 + 专项 4）」 | 实测读数：11 | node --input-type=module -e "import{readdirSync}from'node:fs';console.log(readdirSync('personas/checklists').filter(f=>f.endsWith('.md')).length)" |
| R6 | 只读角色共 12 个（9 个上游 disallowedTools + 3 个批次3 本仓裁决只读） | README.md:47「代码里标 `readonly` 的共 12 个：其中 9 个上游标注 disallowedTools…另 3 个为批次3 移植时本仓裁决只读」 | 实测读数：12 | node --input-type=module -e "import{ROLES}from'./lib/roles.js';console.log(ROLES.filter(r=>r.readonly===true).length)" |
| R7 | 档位分布 HIGH 10 · MEDIUM 11 · LOW 2 | README.md:117「合计：HIGH 10 · MEDIUM 11 · LOW 2 = 23 个角色」 | 实测读数：10/11/2 | node --input-type=module -e "import{ROLES}from'./lib/roles.js';const c={HIGH:0,MEDIUM:0,LOW:0};for(const r of ROLES)c[r.tier]++;console.log(c.HIGH+'/'+c.MEDIUM+'/'+c.LOW)" |
| R8 | 主测试 375 passed / 0 failed | README.md:255「node tests/run.mjs # 主测试（375 passed / 0 failed）」；ARCHITECTURE.md:266 | 实测读数：375/0 | node tests/run.mjs \| node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync(0,'utf8').match(/([0-9]+) passed, ([0-9]+) failed/);console.log(m[1]+'/'+m[2])" |
| R9 | crgate 自测 65 断言 | README.md:247「node tools/crgate.test.mjs（65 断言）」；README.md:256 | 实测读数：65/0 | node tools/crgate.test.mjs \| node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync(0,'utf8');console.log(t.match(/([0-9]+) passed/)[1]+'/'+t.match(/([0-9]+) failed/)[1])" |
| R10 | publish-scan 自测 53 断言（B5 审计修复后 47 → 53） | README.md:248「publish-scan.test.mjs … 53 断言」；README.md:257「# 53 断言」 | 实测读数：passed=53 | node tools/publish-scan.test.mjs \| node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync(0,'utf8').match(/passed=([0-9]+)/);console.log('passed='+m[1])" |
| R11 | README「已知限制」9 条，ARCHITECTURE 同口径「完整 9 条」 | README.md:309「## 已知限制」下编号列表；ARCHITECTURE.md:342「完整 9 条见 README」 | 实测读数：9 | node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync('README.md','utf8');const s=t.slice(t.indexOf('## 已知限制'));const m=s.match(/^[0-9]+[.] /gm);console.log(m?m.length:0)" |
| R12 | 机检工具表列 4 个工具（crgate / publish-scan / install-personas / assemble-review） | README.md:245-250「## 机检工具」表 | 实测读数：4 | node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync('README.md','utf8');const s=t.slice(t.indexOf('## 机检工具'),t.indexOf('## 测试'));const P=String.fromCharCode(124);console.log(s.split('\n').filter(l=>l.startsWith(P)&&l.includes('tools/')).length)" |

## ARCHITECTURE.md（16 断言）

| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |
|---|---|---|---|---|
| A1 | 跟踪文件 164 | ARCHITECTURE.md:16（关键数字表「跟踪文件 164」）；ARCHITECTURE.md:5 | 实测读数：164 | git ls-files -- docs/ lib/ tools/ tests/ personas/ skills/ policies/ scripts/ package.json package-lock.json cordis.patch.yml README.md ARCHITECTURE.md CHANGELOG.md LICENSE THIRD-PARTY-NOTICES.md .gitattributes .gitignore .publish-scan-allow.json \| node --input-type=module -e "import{readFileSync}from'node:fs';console.log(readFileSync(0,'utf8').split('\n').filter(Boolean).length)" |
| A2 | 角色 / 泳道 23（build 10 · review 6 · domain 7） | ARCHITECTURE.md:17 | 实测读数：23/10/6/7 | node --input-type=module -e "import{ROLES}from'./lib/roles.js';const c={build:0,review:0,domain:0};for(const r of ROLES)c[r.lane]++;console.log(ROLES.length+'/'+c.build+'/'+c.review+'/'+c.domain)" |
| A3 | 工作流技能 25（入口 2 · 流水线 4 · 协作 5 · 方法论 13 · 顾问 1） | ARCHITECTURE.md:18；ARCHITECTURE.md:202-229 分组小节 | 实测读数：25=25 | node --input-type=module -e "import{readdirSync}from'node:fs';const d=readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory());const m=d.filter(x=>readdirSync('skills/'+x.name).includes('SKILL.md')).length;console.log(m+'='+[2,4,5,13,1].reduce((a,b)=>a+b,0))" |
| A4 | 评审清单 11（语言 7 + 专项 4） | ARCHITECTURE.md:19；ARCHITECTURE.md:192-194 | 实测读数：11/7/4 | node --input-type=module -e "import{readdirSync}from'node:fs';const a=readdirSync('personas/checklists').filter(f=>f.endsWith('.md'));const spec=['sql','pytorch','a11y','performance'].filter(s=>a.includes(s+'.md')).length;console.log(a.length+'/'+(a.length-spec)+'/'+spec)" |
| A5 | 确定性工具：宿主注册 3（+ own 层 agent_reply），`tools/` 共 23 | ARCHITECTURE.md:20；ARCHITECTURE.md:235 | 实测读数：3/23 | node --input-type=module -e "import{CATALOG}from'./lib/index.js';import{readdirSync}from'node:fs';console.log(Object.keys(CATALOG).length+'/'+readdirSync('tools',{withFileTypes:true}).filter(e=>e.isFile()).length)" |
| A6 | 测试断言合计 551 = 主套件 375 + crgate 65 + publish-scan 53 + persona-gate 33 + taskbook-26a 11 + 隔离门自测 5 + LLM 回放 9 | ARCHITECTURE.md:21；ARCHITECTURE.md:309-319（§7.1 质量账逐门） | 实测读数：551 | node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync('ARCHITECTURE.md','utf8');const m=t.match(/主套件 ([0-9]+) \+ crgate ([0-9]+) \+ publish-scan ([0-9]+) \+ persona-gate ([0-9]+) \+ taskbook-26a ([0-9]+) \+ 隔离门自测 ([0-9]+) \+ LLM 回放 ([0-9]+)/);console.log(m?m.slice(1).reduce((a,b)=>a+Number(b),0):'NOMATCH')" |
| A7 | 运行时依赖 2 个（@deepseek-ai/schemastery + web-tree-sitter@0.27.0） | ARCHITECTURE.md:22（关键数字表「运行时依赖 2」） | 实测读数：2 | node --input-type=module -e "import{readFileSync}from'node:fs';console.log(Object.keys(JSON.parse(readFileSync('package.json','utf8')).dependencies).length)" |
| A8 | lib/ 43 文件 = 顶层 17 + advisor/ 26 | ARCHITECTURE.md:60；ARCHITECTURE.md:33 | 实测读数：43/17/26 | node --input-type=module -e "import{readdirSync}from'node:fs';const w=d=>{let n=0;for(const e of readdirSync(d,{withFileTypes:true}))n+=e.isDirectory()?w(d+'/'+e.name):1;return n};console.log(w('lib')+'/'+readdirSync('lib',{withFileTypes:true}).filter(e=>e.isFile()).length+'/'+w('lib/advisor'))" |
| A9 | personas/ 34 文件 = 23 份角色人格 + checklists/ 11 份 | ARCHITECTURE.md:34；ARCHITECTURE.md:172「## 3. personas/ — 角色人格（34 文件）」 | 实测读数：34/23/11 | node --input-type=module -e "import{readdirSync}from'node:fs';const md=d=>readdirSync(d).filter(f=>f.endsWith('.md')).length;console.log((md('personas')+md('personas/checklists'))+'/'+md('personas')+'/'+md('personas/checklists'))" |
| A10 | skills/ 在盘 29 文件、其中 28 个在 git 跟踪内 | ARCHITECTURE.md:198「在盘 29 个文件 …；其中 28 个在 git 跟踪内」 | 实测读数：29/28 | git ls-files -- skills/ \| node --input-type=module -e "import{readFileSync,readdirSync}from'node:fs';const w=d=>{let n=0;for(const e of readdirSync(d,{withFileTypes:true}))n+=e.isDirectory()?w(d+'/'+e.name):1;return n};console.log(w('skills')+'/'+readFileSync(0,'utf8').split('\n').filter(Boolean).length)" |
| A11 | tools/ 24 文件 = 机检脚本 15 + 测量/读取 6 + 负向自测 2 + 数据 1 | ARCHITECTURE.md:236；ARCHITECTURE.md:37 | 实测读数：24/15/6/2/1 | node --input-type=module -e "import{readdirSync}from'node:fs';const f=readdirSync('tools',{withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.name);const data=f.filter(n=>n.endsWith('.json'));const neg=['crgate.test.mjs','publish-scan.test.mjs'];const measure=['measure-injection-surface.mjs','measure-decay.mjs','zstd-read.mjs','usage-probe.mjs','opt-r2-faced-probe.mjs','toolscope-efficiency.mjs'];const m=f.filter(n=>measure.includes(n));const g=f.filter(n=>neg.includes(n));console.log(f.length+'/'+(f.length-data.length-g.length-m.length)+'/'+m.length+'/'+g.length+'/'+data.length)" |
| A12 | tests/ 13 文件 | ARCHITECTURE.md:38；ARCHITECTURE.md:262「## 6. tests/ — 测试与验收门（13 文件）」 | 实测读数：13 | node --input-type=module -e "import{readdirSync}from'node:fs';console.log(readdirSync('tests',{withFileTypes:true}).filter(e=>e.isFile()).length)" |
| A13 | 隔离门自测 5 场景（5/5 达期望） | ARCHITECTURE.md:268「selftest 5/5」；ARCHITECTURE.md:314 | 实测读数：场景：5/5 | node tests/isolation-gate.mjs --selftest |
| A14 | 计数漂移门变异体 16/16 达期望 | ARCHITECTURE.md:270「变异体 16/16 达到期望」；ARCHITECTURE.md:314 | 实测读数：变异体：16/16 | node tests/skill-sync-check.mjs --selftest |
| A15 | 效果评测 held-out 43/43（C1/C2 双配置均通过） | ARCHITECTURE.md:375-383（§10.1 主对照表） | 实测读数：2 | git grep -n "43/43" -- ARCHITECTURE.md \| node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync(0,'utf8').match(/43\/43/g);console.log(m?m.length:0)" |
| A16 | docs/ 7 个文件（任务书模板 + advisor 契约 + 复用账本 + 设计原则 + 别名契约 + 约束审计 + 本矩阵） | ARCHITECTURE.md:39「docs/ (7)」 | 实测读数：7 | node --input-type=module -e "import{readdirSync}from'node:fs';console.log(readdirSync('docs',{withFileTypes:true}).filter(e=>e.isFile()).length)" |

## CHANGELOG.md（5 断言）

| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |
|---|---|---|---|---|
| C1 | 主套件计数演进链 346 → 347 → 350 → 355 → 356 → 368 → 375，终态 375/0 | CHANGELOG.md:102「主套件计数演进：346 → 347 → … → 375 … 终态 375/0」 | 实测读数：2/true | node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync('CHANGELOG.md','utf8');const m=t.match(/346 → [0-9]+/g);console.log((m?m.length:0)+'/'+t.includes('终态 375/0'))" |
| C2 | 面A 工具面 2663 → 2225 码点（工具级 783 → 255） | CHANGELOG.md:54「面A 工具面 2663 → 2225 码点（Δ−438），工具级 783 → 255」；CHANGELOG.md:66（B2 ③ G0/G1/G2） | 实测读数：2225 | node tools/measure-injection-surface.mjs \| node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync(0,'utf8').match(/面A 工具面\s+合计 ([0-9]+) 码点/);console.log(m[1])" |
| C3 | 工具级 catalog 行各 ≤90 码点、合计 ≤255（零容差） | CHANGELOG.md:54「各 ≤90 合计 ≤255」；CHANGELOG.md:66（G2 裁剪到位） | 实测读数：90/78/87/255 | node --input-type=module -e "import{CATALOG}from'./lib/index.js';const v=Object.values(CATALOG).map(s=>[...s].length);console.log(v.join('/')+'/'+v.reduce((a,b)=>a+b,0))" |
| C4 | 面D 不变式 口径B 1993/2181/2183、meanTotal 6133、maxTotal 6480 | CHANGELOG.md:66「G3 面D 不变式（1993/2181/2183 + meanTotal 6133 + maxTotal 6480，只码点）」 | 实测读数：1993/2181/2183 | node --input-type=module -e "import{resolveConfig}from'./lib/index.js';import{getRole}from'./lib/roles.js';import{loadPersona}from'./lib/persona.js';import{resolveRoute,TIER_INTENT}from'./lib/routing.js';import{composeTaskbook}from'./lib/taskbook.js';import{splitSections,metrics}from'./tools/measure-injection-surface.mjs';const c=resolveConfig({});const o=[];for(const id of ['explore','executor','analyst']){const role=getRole(id);const p=loadPersona(role);const r=resolveRoute({role,tierTable:c.tiers,roleOverrides:c.roleOverrides});const t=composeTaskbook({role,persona:p,route:r,tierIntent:TIER_INTENT[r.tier],task:'梳理 tools 目录脚本的用途清单，输出一页 markdown 索引；只读不改文件。',clarifyMode:'interactive'});const secs=splitSections(t);const cb=s=>metrics(s.text).codepoints;const three=secs.filter(s=>['五、','六、','七、'].some(k=>s.title.includes(k)));const i=t.indexOf('### 本次参数');o.push(cb(secs[0])+three.reduce((n,s)=>n+cb(s),0)+[...(i>=0?t.slice(i):'')].length)}console.log(o.join('/'))" |
| C5 | 动态 provider 接入回归测试 4 条 | CHANGELOG.md:20「回归测试 4 条（tests/run.mjs）」 | 实测读数：4 | git grep -c "await testAsync('动态 provider" -- tests/run.mjs |

## 工具描述（三工具 catalog 行 + help）（6 断言）

| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |
|---|---|---|---|---|
| T1 | 三工具 catalog 行码点 90 / 78 / 87（各 ≤90） | README.md:53「三工具工具级 description 裁为三行 catalog（各 ≤90 码点）」；lib/index.js:304-322（CATALOG） | 实测读数：90/78/87 | node --input-type=module -e "import{CATALOG}from'./lib/index.js';console.log(Object.values(CATALOG).map(s=>[...s].length).join('/'))" |
| T2 | help 全量 = H 1169（H_static 783 / H_action 332 / 回本轮数 R=3） | CHANGELOG.md:66「G5 并列读数 H=1169、H_static=783、H_action=332 … R=3」；ARCHITECTURE.md:147 | 实测读数：1169/783/332/3 | node --input-type=module -e "import{rolesTool,taskbookTool,spawnTool,resolveConfig,composeHelp,STATIC_ARCHIVE}from'./lib/index.js';const c=resolveConfig({});const d={agent_roles:rolesTool({},c,null),agent_taskbook:taskbookTool({},c,null),agent_spawn:spawnTool({},c,null,()=>null,null)};const h=composeHelp(d);const H=[...h].length;const S=Object.values(STATIC_ARCHIVE).reduce((n,s)=>n+[...s].length,0);const T=[...h.split('\n')[0]].length+1;console.log(H+'/'+S+'/'+(H-S-T)+'/'+Math.ceil(H/528))" |
| T3 | agent_roles 的 action 合法清单 6 项（list/show/tiers/set/reset/help） | README.md:99「动作：list、show、tiers、set、reset、help」；lib/index.js（rolesTool parameters.action.enum） | 实测读数：6 | node --input-type=module -e "import{rolesTool,resolveConfig}from'./lib/index.js';const c=resolveConfig({});console.log(rolesTool({},c,null).parameters.properties.action.enum.length)" |
| T4 | agent_spawn 参数 20 个（含 allowTools 单授） | README.md:101「…；allowTools 按会话单授…」；CHANGELOG.md:61 | 实测读数：20/true | node --input-type=module -e "import{spawnTool,resolveConfig}from'./lib/index.js';const c=resolveConfig({});const p=spawnTool({},c,null,()=>null,null).parameters.properties;console.log(Object.keys(p).length+'/'+('allowTools' in p))" |
| T5 | STATIC_ARCHIVE 三段原文码点 267 / 191 / 325（合计 783） | CHANGELOG.md:55「STATIC_ARCHIVE（迁移前工具级原文逐字存档，267/191/325 码点）」 | 实测读数：267/191/325 | node --input-type=module -e "import{STATIC_ARCHIVE}from'./lib/index.js';console.log(Object.values(STATIC_ARCHIVE).map(s=>[...s].length).join('/'))" |
| T6 | help 存档指纹 fixture 3 条 entries（Q3 漂移门 3/3） | CHANGELOG.md:57「Q3 存档 sha256 fixture（3/3）」；tests/fixtures/b2-help-archive.sha256.json | 实测读数：3 | node --input-type=module -e "import{readFileSync}from'node:fs';const j=JSON.parse(readFileSync('tests/fixtures/b2-help-archive.sha256.json','utf8'));console.log(Object.keys(j.entries).length)" |

## docs（design-principles / task-brief-v3 / advisor-contract）（6 断言）

| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |
|---|---|---|---|---|
| D1 | advisor 契约正文 11 个二级节 | docs/advisor-contract.md（`## ` 标题行） | 实测读数：11 | node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync('docs/advisor-contract.md','utf8').match(/^## /gm);console.log(m?m.length:0)" |
| D2 | design-principles 现有原则 1 条 | docs/design-principles.md:7「现有原则 1 条」；docs/design-principles.md:11 | 实测读数：1 | node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync('docs/design-principles.md','utf8').match(/^## /gm);console.log(m?m.length:0)" |
| D3 | design-principles 时钟盘点口径：`lib/` 全部 36 个 `.js`（**历史时点 `6d0f71d`**；当前树 42 个，见报告） | docs/design-principles.md:79「lib/ 全部 36 个 .js 时钟命中 27 处」 | 实测读数：36 | git ls-tree -r --name-only 6d0f71d -- lib/ \| node --input-type=module -e "import{readFileSync}from'node:fs';console.log(readFileSync(0,'utf8').split('\n').filter(l=>l.endsWith('.js')).length)" |
| D4 | 同上口径时钟命中 27 处（`Date.now` / `setTimeout` / `new Date` 三模式、commit `6d0f71d`） | docs/design-principles.md:61「命中 27 处，其中 23 处是 B 类」；:79 | 实测读数：27 | git grep -c -e "Date[.]now" -e "setTimeout" -e "new Date" 6d0f71d -- lib/ \| node --input-type=module -e "import{readFileSync}from'node:fs';const t=readFileSync(0,'utf8').trim();const s=t?t.split('\n').filter(Boolean).reduce((n,l)=>n+parseInt(l.split(':').pop(),10),0):0;console.log(s)" |
| D5 | advisor 输出预算 ADVISOR_MAX_TOKENS = 16384，总注入上限 48KB（8KB 基础 + 40KB 检索并列独立） | docs/advisor-contract.md:336「ADVISOR_MAX_TOKENS = 16384」；lib/advisor/retrieval/budget.js:45-60 | 实测读数：16384/8192/40960/49152 | node --input-type=module -e "import{ADVISOR_MAX_TOKENS}from'./lib/advisor/runtime.js';import{BASE_CONTEXT_BYTES,RETRIEVAL_TOTAL_BYTES,TOTAL_INJECTION_BYTES}from'./lib/advisor/retrieval/budget.js';console.log(ADVISOR_MAX_TOKENS+'/'+BASE_CONTEXT_BYTES+'/'+RETRIEVAL_TOTAL_BYTES+'/'+TOTAL_INJECTION_BYTES)" |
| D6 | task-brief-v3 模板 20 个二级节 | docs/task-brief-v3.md 全文（`## ` 标题行） | 实测读数：20 | node --input-type=module -e "import{readFileSync}from'node:fs';const m=readFileSync('docs/task-brief-v3.md','utf8').match(/^## /gm);console.log(m?m.length:0)" |

---

## 估算口径登记（不进主表，故不计入断言行数）

本仓对外表述里有 3 处是**估算/外推**，不是当次实测。它们不进上表（上表只收「有可执行复现路径」的断言），
在此单独登记，防止被当成实测摘引：

1. **归档成本估算 ≈528 码点**（B2 净降估算，`CHANGELOG.md:66` 与 `agent-out/opt-b2-s3-readings.md`）：
   528 是组织者 R-5 的**估算值**，非实测；实测净降 438 码点（= 528 − action 13 − allowTools 77）。
   复现：`node tools/opt-b2-s3-gate.mjs --selftest`（门只判净增 ≤0，不判 528 本身）。
2. **回本轮数 R = ceil(H/528) = 3**（`CHANGELOG.md:66`）：528 是估算分母，故 R 亦为估算口径。
   实测部分是 H=1169（见 T2）；R 由估算分母派生。
3. **效果评测耗时 ~117 min / 时间约 ×2.2**（`ARCHITECTURE.md:379-383,392`）：单次实验的时间读数，
   n=1 现场观测值，**无重复测量**，不可作为「编排耗时倍数」的实测断言使用。
   文档本身已声明「探索性证据，不做显著性声明」。

## 文档漂移清单（本表不改文档，只登记真值）

以下 5 处对外表述曾与工作树实测不符，**均已于 2026-10-29 由组织者收尾修订完毕**（状态列 = 当前状态）：

| # | 位置 | 原表述 | 实测值 | 差额 | 处置 |
|---|---|---|---|---|---|
| DR1 | README.md:47 | 只读角色「9 个角色」（列了 9 个 id） | 12 | +3 | ✅ 已修订：改为「标 `readonly` 共 12 个：9 个上游 disallowedTools + 3 个批次3 本仓裁决只读」，并逐一点名（`lib/roles.js` 里 `readonly:true` 共 12） |
| DR2 | README.md:117 | 「HIGH 11 · MEDIUM 10 · LOW 2 = 23」 | HIGH 10 · MEDIUM 11 · LOW 2 | 两档互换 | ✅ 已修订：改为「HIGH 10 · MEDIUM 11 · LOW 2 = 23」 |
| DR3 | ARCHITECTURE.md:22 | 「运行时依赖 1（@deepseek-ai/schemastery）」 | 2（+ web-tree-sitter 0.27.0） | +1 | ✅ 已修订：关键数字表改「2」，并同步第 282/285 行「装 1 个运行时依赖」→「2 个」 |
| DR4 | ARCHITECTURE.md:342 | 「完整 8 条见 README「已知限制」」 | 9 | +1 | ✅ 已修订：改为「完整 9 条」 |
| DR5 | ARCHITECTURE.md:123 | 「`retrieval/`（6 文件）」 | 7 | +1 | ✅ 已修订：改为「（7 文件）」并补「符号」职责；与同文 :90 的「（7）」一致 |

> 这五处由本表 R6/R7/R11/A7 与漂移清单共同发现，**发现者=B7 席，修订者=组织者**（B7 按纪律不改共享写域）。修订后 R6/R7/R11/A7 四行已同步改为「文档与实测一致」口径。

另有两处**时点差异**不算漂移，但评审者需注意：
- `docs/design-principles.md:79`「lib/ 全部 36 个 `.js`、时钟 27 处」是 `master@6d0f71d` 的盘点值；
  当前树已 42 个 `.js` / 37 处时钟命中。文档 1.5 节已自述「以落笔时点实测工作树为准」，属如实标注（D3/D4 复现命令即钉死该 commit）。
- `ARCHITECTURE.md:328`「全量 git 历史（56 commits）」是 2026-09-30 gitleaks 扫描时点值；
  当前 `git rev-list --count HEAD` = 171。属历史记录，非当前断言。

## 抽查范围（外部评审者怎么用这张表）

- **最小抽查集**（建议 ≥10 条，覆盖五种载体）：R1（角色数）、R3（技能数）、R8（主套件 375）、
  R10（publish-scan 53）、C2（面A 2225）、T1（catalog 90/78/87）、T2（help H 1169）、
  D3/D4（历史时点时钟口径，**非漂移**）、A1（跟踪文件 164）、A7（运行时依赖 2）、
  R6/R7（只读角色 12 / 档位分布 10·11·2）——后四行原为漂移点，2026-10-29 已随文档修订对齐。
- **机检优先**：`node tools/verifiability-check.mjs`（静态 V1–V5）+ `--execute`（X1 逐条真跑核对读数）
  + `--selftest`（5 变异体注入必红）。门绿只证明「登记完整 + 路径可执行 + 读数可复现」，
  **不证明数字本身仍然正确** —— 数字正确性由 X1 逐条真跑与人工抽查共同承担。
- **诚实边界**：本表是**登记**不是**审计结论**；标 `实测读数：` 的行只表示「该读数由该命令在上表测量时点跑出」，
  不表示该数字在 README 的语境里一定被正确使用。DR1–DR5 五处漂移就是这种「登记真值 ≠ 文档表述正确」的实例：
  本表只保证**真值可复现**，文档修订属组织者收尾范围。
