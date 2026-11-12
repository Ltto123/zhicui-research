# 上游来源与改造范围

BYOK 来源：[K-Dense-AI/k-dense-byok 固定提交](https://github.com/K-Dense-AI/k-dense-byok/tree/6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0)，提交号 `6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0`。

`server/upstream/atomic-json.ts`、`canonical-json.ts`、`http-proxy.ts`源于该提交，随后有本项目适配；MIT 原许可保存在同目录 [LICENSE](server/upstream/LICENSE)。持久化研究会话适配位于 `server/upstream/research-session-runtime.ts`。

`server/providers.ts`按 `server/src/agent/session-registry.ts`的 Pi SDK 会话构建流程裁剪改写，使用相同固定 Pi 1.3.0 包；显式资源和工具边界依据 Pi SDK `examples/sdk/12-full-control.ts`。框架保留 Fastify 与 Next.js/React，新的任务控制器和界面替换旧 Python/V2 产品；没有将旧服务作为运行依赖。

任务状态、项目材料、生效方法、论证清单、证据范围、自动审查修订与成果导出为智萃新增实现。未复制上游预算、Modal、326张启动卡及专有文档技能。项目方法卡为本项目已有资产；docx/mammoth/pdfjs/Playwright承担文件处理。

首版不等同完整上游功能集合；具体可用接入和实测覆盖见测试记录。

## 科研技能与依赖许可

`literature-review` 1.11 与 `citation-management` 2.3 来自 [K-Dense-AI/scientific-agent-skills 的固定提交](https://github.com/K-Dense-AI/scientific-agent-skills/tree/a1043ef544e3a100c28e70a736b6cf32554d0677)；`arxiv` 1.0.0 来源为 [NousResearch/hermes-agent 的 arXiv Skill](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/arxiv/SKILL.md)。三份原始 SKILL 均有明确 MIT 标记，但归属不能由 BYOK 许可证代替。适配范围、原件哈希、arXiv 来源提交缺口和完整许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Pi SDK 固定为 1.3.0；其独立 MIT 归属及 npm 依赖的不同许可证也列在上述声明中。源码包与包含依赖、原生库或浏览器的安装包有不同分发范围，不能以本文件推定所有依赖均为 MIT。

## Agentero 文献管理设计参考

2026-10-29 审阅 [poco-ai/Agentero 固定提交](https://github.com/poco-ai/Agentero/tree/1034143fa13c17a7313fa7b99ce7cea434f0433b)，提交号 `1034143fa13c17a7313fa7b99ce7cea434f0433b`（0.14.0）。

“文献夹”借鉴其独立文献条目、按明确标识去重、标签与独立个人笔记的组织方式，参考 `crates/agentero-core/src/features/paper/catalog/`、`src/lib/paper/tags.ts` 及 `docs/backend/data-model.md`。智萃按现有 Fastify/React 架构独立实现，没有复制 Agentero 的运行时模块或新增其依赖。个人阅读进度与 AI 研读状态分开，笔记不会自动进入研究上下文。

没有引入其 Tauri/Rust 桌面壳、ACP/MCP 执行层、云解析服务或 Zotero translation-server。书目导出由本地纯函数生成，不向第三方转换服务发送论文记录。Agentero 根许可证为 MIT，但整包的第三方依赖另有各自许可，不能据根许可证推断整个发行物均为 MIT。
