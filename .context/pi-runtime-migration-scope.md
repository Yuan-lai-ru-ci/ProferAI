# Pi Runtime → Profer 迁移范围

- Integration baseline: `009e75f1a4ecedaec6dcea14613c3952fa395650`
- Shared ancestor: `0b5fd8432b1caee4deda736ab4e5cc265718368c`
- Pi source: `feature/pi-runtime-sync@9b98e5cdf775cec2eda8ba19d4d1e463e4005150`
- Worktree: `D:/profer/Profer-pi-integration`

本分支只迁移 Pi 双 runtime，并将其适配到当前 Profer 的知识库、任务图、会话、工作区、权限和渠道语义。

明确排除：`D:/profer/Proma-main` 的未提交工作、PaperPipe release integration、push、tag 与发布。

回滚：删除此隔离分支；不得通过 reset/clean 改动原主工作树。
