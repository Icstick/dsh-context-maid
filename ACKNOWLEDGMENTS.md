# 致谢（Acknowledgments）

dsh-context-maid 站在以下项目的肩膀上：

- **DeepSeek Harness**（@deepseek-ai/dsh-compaction-basic、dsh-compaction-tool-result-pruner、dsh-llm、dsh-session）——折叠/瘦身 seam 与官方实现：maid 继承并复刻其调用语义（maid-summarizer.mjs 的压缩指令模板与 BlockAssembler 语义源自官方 compaction-basic，同步源注释于文件头）。
- **dsh-adaptive-context（ACP）**——归档目标 ledger（compaction/summary → evidence）与 PIN 高权威源（queryObservations）。
- **dsh-work-continuity（WC）**——PIN 目标源（work_state goal）。
- 参考项目的模式与灵感（详见各实现头注）。

MIT License 兼容使用；以上项目各自的许可以其仓库为准。
