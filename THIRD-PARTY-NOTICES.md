# 第三方许可与版权声明（THIRD-PARTY NOTICES）

本仓库是 DSH 插件 `dsh-agents` 的源码。其中的**角色体系**（`personas/` 下的角色人格文件、
`personas/checklists/` 的按语言评审清单，以及 `skills/` 中沿用的工作流约定）移植自以下
上游项目（README 的「移植来源」一节亦已注明）：

- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC）——19 个基础角色
  人格的底本（18 个逐字翻译移植；code-reviewer 在底本上深度改造升级为 v2.3，不再逐字）
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code)（ECC）——
  4 个专项角色（rag-reviewer / silent-failure-hunter / spec-miner / harness-optimizer）的
  方法论来源、`personas/checklists/` 语言评审清单、以及 `skills/opensource-sanitize` 等技能
  的移植来源
- [Multi-Agent-Custom-Automation-Engine-Solution-Accelerator](https://github.com/microsoft/Multi-Agent-Custom-Automation-Engine-Solution-Accelerator)（MACAE）——
  `skills/subagent-clarify` 的工具级 HITL 机制参考来源

依 MIT 许可的要求，下列原始版权声明与许可全文在此保留，随本仓库一并分发。

---

## oh-my-claudecode（OMC）

- 来源：https://github.com/Yeachan-Heo/oh-my-claudecode
- 许可：MIT License
- 移植方式：逐字翻译移植为 DSH 原语可执行的形态（code-reviewer 后经深度改造升级 v2.3）；
  对照底本（OMC 原文快照）与逐文件
  一致性核验记录见仓库内 `review/` 与移植批次档案（本地过程物，不随公开版本分发）。

```
MIT License

Copyright (c) 2025 Yeachan Heo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## everything-claude-code（ECC）

- 来源：https://github.com/affaan-m/everything-claude-code
- 许可：MIT License
- 移植方式：4 个专项角色人格的方法论内联改写（rag-reviewer / silent-failure-hunter /
  spec-miner / harness-optimizer）、`personas/checklists/` 语言评审清单、
  `skills/opensource-sanitize`（发布前脱敏方法论全量移植）、`skills/agent-autopilot`
  选角触发表。

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Multi-Agent-Custom-Automation-Engine-Solution-Accelerator（MACAE）

- 来源：https://github.com/microsoft/Multi-Agent-Custom-Automation-Engine-Solution-Accelerator
- 许可：MIT License
- 移植方式：`skills/subagent-clarify` 的工具级 human-in-the-loop 澄清机制参考
  （与 OMC AskUserQuestion failure-mode guard 混合来源，DSH 广播原语同构重写）。

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 其他

`node_modules/` 下的第三方依赖各自携带其许可文件，不在此逐一列举；本仓库自身代码以
根目录 [LICENSE](LICENSE) 的 MIT 许可发布。
