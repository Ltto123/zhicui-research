# Third-party notices / 第三方许可与归属

核查日期：2026-11-12。适用范围：本目录中的智萃源码分发包，以及下列明确列出的第三方来源。

本文件保留第三方归属和许可，不改变原许可，也不为智萃自有代码、论文原文、数据库内容、模型服务或商标另行授予权利。依赖项的许可不能统一概括为 MIT。

当前 `scripts/prepare-release.mjs` 制作源码包，排除 `node_modules` 和生成的运行产物。安装依赖后再分发 `node_modules`、前端构建文件、原生库、浏览器或桌面安装包，属于不同的分发范围，须同时保留实际随包组件的完整许可、归属和相关源码义务；本文件中的依赖表不代替这些文件。

## 1. K-Dense BYOK 代码

上游：[K-Dense-AI/k-dense-byok](https://github.com/K-Dense-AI/k-dense-byok/tree/6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0)，固定提交 `6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0`。

本项目使用或改写的部分包括 `server/upstream/atomic-json.ts`、`canonical-json.ts`、`http-proxy.ts`、`research-session-runtime.ts`，以及 `UPSTREAM.md` 记录的会话构建改写。它们不是整个上游产品的未修改副本。

归属：Copyright (c) 2026 K-Dense。MIT 许可全文随包保存在 [server/upstream/LICENSE](server/upstream/LICENSE)，与[该提交的官方 LICENSE](https://github.com/K-Dense-AI/k-dense-byok/blob/6a55f5ce6f4bd9ac7ff75d01ec20d7f27073a9f0/LICENSE)一致。分发这些部分时保留该文件及本节来源说明。

## 2. Literature Review 与 Citation Management Skills

这两份适配规则的来源不是 BYOK 代码许可证，而是独立的 [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills/tree/a1043ef544e3a100c28e70a736b6cf32554d0677) 项目，固定提交 `a1043ef544e3a100c28e70a736b6cf32554d0677`。

| 来源 | 核实的版本与逐文件许可 | 本项目适配位置 |
| --- | --- | --- |
| [skills/literature-review/SKILL.md](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a1043ef544e3a100c28e70a736b6cf32554d0677/skills/literature-review/SKILL.md) | 1.11；MIT；skill-author: K-Dense Inc. | `server/upstream/research-skills/literature-review/SKILL.md`、`server/research-skills.ts` |
| [skills/citation-management/SKILL.md](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a1043ef544e3a100c28e70a736b6cf32554d0677/skills/citation-management/SKILL.md) | 2.3；MIT；skill-author: K-Dense Inc. | `server/upstream/research-skills/citation-management/SKILL.md`、`server/research-skills.ts` |

本项目改写了规则，使其使用宿主注册的研究工具、持久化证据、引用门槛、提纲确认和局部修订流程。未随这些适配规则复制上游 Python 脚本、全部参考材料或其他 Skills。`sourceVersion` 指来源版本，不表示本项目适配文本与该版本逐字相同。

已核对安装来源记录、保留的上游 SKILL 原件及上述固定提交的公开 frontmatter。两份上游原件 SHA-256 分别为：

- literature-review：`16a9e85bcdcb9bb859e1646bf836e51b22900445ba2e367d8d75be05b5a5cba8`
- citation-management：`dc79fe1e8438dcf598040615d5323360c6a7ed0b868fc3ffc82512c871a1e3ff`

以下为其[固定提交许可证](https://github.com/K-Dense-AI/scientific-agent-skills/blob/a1043ef544e3a100c28e70a736b6cf32554d0677/LICENSE.md)的完整文本：

```text
MIT License

Copyright (c) 2025 K-Dense Inc.

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

## 3. arXiv Skill / Hermes Agent

上游：[NousResearch/hermes-agent, skills/research/arxiv/SKILL.md](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/arxiv/SKILL.md)。本机来源及核查时的官方文件均明确标记 `version: 1.0.0`、`author: Hermes Agent`、`license: MIT`。

本项目适配位置：`server/upstream/research-skills/arxiv/SKILL.md`、`server/research-skills.ts`。适配文本约束学科适用性、版本身份、阅读范围及宿主工具权限；未引入整个 Hermes Agent 或其执行环境。

所核查安装来源 SKILL 的 SHA-256 为 `9b41877bcb64166dc2355a43aedd3198c3e5214af67f09e1d1b717a989d92f72`。现有安装记录未提供该原件的 Git 提交；上述 `main` 链接用于记录已核实的作者、版本及许可，不宣称它是可复现的固定提交。后续更新应补存明确提交，不以相同版本号推定文件完全相同。

以下为[官方仓库许可证](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)的完整文本；其版权归属独立于 K-Dense：

```text
MIT License

Copyright (c) 2025 Nous Research

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

## 4. Pi SDK 1.3.0

`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 均固定为 1.3.0，安装包元数据标记 MIT，来源仓库为 [earendil-works/pi](https://github.com/earendil-works/pi/tree/v1.3.0)。本项目参考的 Pi SDK 示例也按该仓库来源保留归属。已检查的三个安装包根目录未附完整 LICENSE，因此在此补存[官方 v1.3.0 LICENSE](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE)：

```text
MIT License

Copyright (c) 2025 Mario Zechner

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

## 5. 直接依赖清单

本表按当前 `package.json`、`package-lock.json` 及已安装包的 `package.json`/许可文件核对。除上节补存的 Pi SDK 许可外，若随产品分发下列依赖，应保留对应包中的完整许可及其嵌套第三方声明。仅在源码包里列出依赖名称与安装指令，不表示依赖二进制已经随包交付。

| 运行依赖 | 固定版本 | 包声明许可 |
| --- | --- | --- |
| `@earendil-works/pi-agent-core` | 1.3.0 | MIT；见第 4 节 |
| `@earendil-works/pi-ai` | 1.3.0 | MIT；见第 4 节 |
| `@earendil-works/pi-coding-agent` | 1.3.0 | MIT；见第 4 节 |
| `@fastify/multipart` | 9.0.3 | MIT |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 |
| `@xmldom/xmldom` | 0.8.15 | MIT |
| `csv-parse` | 6.1.0 | MIT |
| `docx` | 9.5.1 | MIT |
| `fastify` | 5.8.5 | MIT |
| `ipaddr.js` | 2.5.0 | MIT |
| `jszip` | 3.10.2 | MIT OR GPL-3.0-or-later；本项目按 MIT 选项使用 |
| `katex` | 0.16.25 | MIT |
| `linkedom` | 0.18.14 | ISC |
| `lucide-react` | 0.577.0 | ISC；所含 Feather 部分另保留 MIT |
| `mammoth` | 1.11.0 | BSD-2-Clause |
| `marked` | 17.0.6 | MIT |
| `next` | 16.3.7 | MIT；内嵌组件另有许可 |
| `pdfjs-dist` | 5.6.205 | Apache-2.0；字体、CMaps、WASM、ICC 文件另有许可 |
| `playwright` | 1.58.2 | Apache-2.0；另附 NOTICE / ThirdPartyNotices.txt |
| `react` | 19.2.3 | MIT |
| `react-dom` | 19.2.3 | MIT |
| `typebox` | 1.3.7 | MIT |
| `undici` | 8.5.0 | MIT |
| `zod` | 4.3.6 | MIT |

| 开发依赖 | 固定版本 | 包声明许可 |
| --- | --- | --- |
| `@types/node` | 24.10.1 | MIT |
| `@types/react` | 19.2.14 | MIT |
| `@types/react-dom` | 19.2.3 | MIT |
| `tsx` | 4.21.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0；另附 ThirdPartyNoticeText.txt |
| `vitest` | 4.1.4 | MIT |

## 6. 含依赖或二进制分发时的额外范围

锁文件当前有 406 个第三方包条目，包含多个平台的可选包；这不是当前平台实际安装或最终分发的文件清单。以下已发现的例外需要按最终制品核对，不能仅依据直接依赖表判断：

- `@img/sharp-libvips-*` 1.3.4 标记 LGPL-3.0-or-later；`@img/sharp-win32-*` 0.35.5 标记 Apache-2.0 AND LGPL-3.0-or-later；`@img/sharp-wasm32` 还含 MIT。若分发这些原生库，须按相应许可处理归属、许可全文、源码可得性及替换/重新链接等适用要求，不能只复制 Sharp 顶层 Apache 许可证。
- `lightningcss` 及其平台包 1.33.0 标记 MPL-2.0；当前锁文件将其列为开发依赖。若最终制品含其代码或二进制，需另核对其分发范围及对应源码要求。
- `caniuse-lite` 1.0.30001819 数据标记 CC-BY-4.0；`pako` 1.0.11 标记 MIT AND Zlib。保留数据/代码自身的声明。
- `lucide-react/LICENSE` 同时包含 Lucide Contributors 的 ISC 文本和 Cole Bemis / Feather 的 MIT 文本，须完整保留。
- `pdfjs-dist/standard_fonts/LICENSE_LIBERATION` 为 SIL Open Font License 1.1，含 Google / Red Hat 归属及保留字体名；`LICENSE_FOXIT` 为 PDFium 的独立声明。另保留实际分发的 `cmaps/LICENSE`、`iccs/LICENSE` 及 `wasm/LICENSE_*`，不能仅带 `pdfjs-dist/LICENSE`。
- 保留 Playwright 的 `LICENSE`、`NOTICE`、`ThirdPartyNotices.txt`，以及实际分发的 `playwright-core`/浏览器组件声明。下载并附带 Chromium、Edge 或其他浏览器需要单独按该浏览器制品核查，不由 Playwright 许可证一并授权。
- Next.js 在 `dist/compiled` 中内嵌其他项目，保留所分发目录中的各自许可证。打包、裁剪或生成前端构建文件时，应收集实际被包含代码的许可声明。

MIT、ISC、BSD 的版权和免责文字，以及 Apache-2.0 的完整许可证、适用 NOTICE 和修改声明，均应按实际组件保留。上面不是所有传递依赖逐文件审查完成的声明；升级锁文件、改变平台或改为安装包分发时重新核对。

## 7. 设计参考与产品边界

`UPSTREAM.md` 记录的 [poco-ai/Agentero](https://github.com/poco-ai/Agentero/tree/1034143fa13c17a7313fa7b99ce7cea434f0433b) 为文献管理设计参考，本项目记录的范围未复制其运行时模块或引入其依赖；因此不把 Agentero 整包描述为本产品的组成部分。

上述 Skills 的许可适用于相应技能文档/代码，不授予论文、期刊全文、数据库、API、模型权重或外部服务的使用/再分发权限。来源署名也不表示上游作者对本产品的认可或担保。项目未在本文件中为自有代码选择对外发布许可证。
