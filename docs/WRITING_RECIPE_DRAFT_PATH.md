# Writing MCP：Draft JSON → LaTeX → 导出包

外部模型或人工提供结构化 `ReportDraft` / `SectionDraft` JSON，`hep_render_latex` 确定性地生成 LaTeX 与逐句归属信息，`hep_export_project` 导出文稿和参考文献文件。

渲染成功只表示草稿已经转换为文件。渲染器不核验原文是否支持句子，也不执行引用 allowlist、事实句缺引用或手写引用归属检查。正式使用前，需要对照源材料核验事实、计算与引用。

`is_grounded` 是调用方提供的声明：省略时保持未知，明确的 `false` 和 `true` 原样保留。提供 `true` 不会触发核验，也不使草稿获得已验证状态。尚未核验的草稿可以渲染，但不得依靠元数据把它表述为已核验结果。

Executable idea-to-computation planning requires a supplied `method_spec` with `files` and `run_card`. Missing methods are refused before executable artifacts are written; planning never substitutes a result-writing runner for the requested operation.

## 1. 创建项目与产物会话

持久材料应属于已初始化的外部研究项目。先运行 `nullius status --json`，并在 HEP 调用中持续传入该项目的绝对 `project_root`。

```json
{
  "tool": "hep_project_create",
  "args": {
    "project_root": "/absolute/path/to/external-project",
    "name": "writing-assets",
    "description": "Draft and source materials"
  }
}
```

```json
{
  "tool": "hep_run_create",
  "args": {
    "project_root": "/absolute/path/to/external-project",
    "project_id": "<project_id>"
  }
}
```

HEP 项目与 run 保存领域目录、manifest 和产物，不负责通用研究生命周期、暂停或审批。

## 2. 准备引用映射与 BibTeX

从检索结果或已读文献选定 INSPIRE recid。`recids` 接受数字字符串或 `inspire:<digits>`；引用映射可把这些标识符转换为既有 citekey。

```json
{
  "tool": "hep_run_build_citation_mapping",
  "args": {
    "project_root": "/absolute/path/to/external-project",
    "run_id": "<run_id>",
    "identifier": "arXiv:XXXX.XXXXX",
    "allowed_citations_primary": ["inspire:627760"],
    "include_mapped_references": true
  }
}
```

该步骤可生成 `allowed_citations_v1.json`、`citekey_to_inspire_v1.json` 与 `bibliography_raw_v1.json`。allowlist 是上游选材信息，渲染器不强制执行它。未显式提供 `cite_mapping` 时，渲染器读取存在的 `citekey_to_inspire_v1.json`；没有匹配的 citekey 时使用 `inspire:<recid>`。

## 3. 构建和检索源材料

```json
{
  "tool": "hep_run_build_writing_evidence",
  "args": {
    "project_root": "/absolute/path/to/external-project",
    "run_id": "<run_id>",
    "continue_on_error": true,
    "latex_sources": [{ "identifier": "arXiv:XXXX.XXXXX" }]
  }
}
```

`continue_on_error` 默认为 `false`。设为 `true` 后，单个 source 失败会记为 `failed/skipped`，可在 `writing_evidence_source_status.json` 中查看错误与抽取数量。部分构建成功不表示材料完整，也不表示论断已有支持。

通过 `hep_project_query_evidence` 或 `hep_project_query_evidence_semantic` 定位材料，再用 `hep_project_playback_evidence` 阅读相应段落。引用应经过对原文的实质核对。

## 4. 渲染结构化草稿

尚未核验时省略 `is_grounded`；只有在调用方已经核对相应材料后，才明确声明 `true`。例如以下草稿没有作出 grounding 声明：

```json
{
  "tool": "hep_render_latex",
  "args": {
    "project_root": "/absolute/path/to/external-project",
    "run_id": "<run_id>",
    "draft": {
      "version": 1,
      "title": "Draft section",
      "paragraphs": [{
        "sentences": [{
          "sentence": "A draft statement requiring source verification.",
          "type": "fact",
          "recids": ["627760"]
        }]
      }]
    }
  }
}
```

此步骤生成 `rendered_latex.tex` 和 `rendered_section_output.json`，后者保存逐句归属字段。`recids` 生成 LaTeX 引用；不提供 `recids` 的句子也可渲染。渲染器不生成 `rendered_latex_verification.json`，也不提供将草稿提升为已验证文稿的功能。

## 5. 导出文稿与参考文献

```json
{
  "tool": "hep_export_project",
  "args": {
    "_confirm": true,
    "project_root": "/absolute/path/to/external-project",
    "run_id": "<run_id>"
  }
}
```

导出可生成 `coverage_report.json`、`report.tex`、`report.md`、`master.bib` 与 `research_pack.zip`。LaTeX 中出现的每个 citekey 必须有真实 BibTeX 条目，导出器会拒绝缺失项。可通过 `writing_master.bib` 或 `bibliography_raw_v1.json` 补齐。

## 失败处理

- 源材料构建失败：检查 `writing_evidence_source_status.json`，补齐下载或解析失败的材料。
- 草稿格式或 recid 不合法：修正输入 JSON，再渲染。
- 导出提示 `Missing BibTeX entries for one or more cite keys`：为报告中的全部 citekey 补齐 BibTeX，不能用占位条目替代。

BibTeX 完整性保证引用键能在参考文献中找到条目；它不证明来源支持正文的论断。
