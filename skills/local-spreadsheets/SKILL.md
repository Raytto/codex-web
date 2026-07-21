---
name: local-spreadsheets
description: Create, edit, inspect, analyze, and verify local spreadsheet files with openpyxl and pandas. Use for standalone .xlsx, .xlsm, .xls, .csv, or .tsv tasks, including formulas, formatting, tables, charts, cleanup, aggregation, and workbook questions. Do not use for Google Sheets, a connected spreadsheet app, or live Microsoft Excel control.
---

# Local Spreadsheets

Use the managed local Python runtime. Never call `load_workspace_dependencies`, `@oai/artifact-tool`, a spreadsheet connector, or desktop Excel automation.

## Choose the workflow

- Use `openpyxl` to create or edit `.xlsx`/`.xlsm`, especially when preserving formulas, styles, merged cells, dimensions, validation, tables, or charts.
- Use `pandas` for analysis, joins, cleanup, aggregation, CSV/TSV handling, and bulk tabular transformations. Write final styled workbooks with `openpyxl`.
- Convert legacy `.xls` to `.xlsx` in the job runtime with headless LibreOffice before processing. Do not overwrite the source.
- Treat formula evaluation separately: `openpyxl` preserves and writes formulas but does not calculate them. Mark the workbook for full recalculation on open; use headless LibreOffice on a temporary copy when calculated values must be verified.

Run Python through `"$CWW_SHARED_PYTHON"`. Keep scripts, previews, converted copies, and caches under `$CWW_JOB_RUNTIME`. Save only the requested final files under `outputs/`.

## Read or analyze

1. Inspect sheet names, dimensions, headers, formulas, merged ranges, hidden rows/columns, and representative values before deciding how to process the file.
2. Load formula and cached-value views separately when calculation lineage matters:

   ```python
   formulas = openpyxl.load_workbook(path, data_only=False, read_only=True)
   cached = openpyxl.load_workbook(path, data_only=True, read_only=True)
   ```

3. Preserve identifiers such as account numbers, SKUs, ZIP codes, and leading-zero codes as text. Parse dates, percentages, and currency into typed values rather than display strings.
4. For read-only questions, answer from the workbook without creating a modified copy unless requested.

## Create or edit

1. Preserve the uploaded source and write a new output file. For `.xlsm`, use `keep_vba=True` and retain the `.xlsm` extension; never execute macros.
2. Make targeted edits to existing workbooks. Do not rebuild a formatted workbook through `pandas.to_excel()` because that discards workbook features and styling.
3. Put assumptions and source data in clear input areas. Use auditable formulas for derived values, with correct absolute and relative references.
4. Match existing fonts, fills, borders, alignment, number formats, widths, row heights, merged cells, freeze panes, filters, validation, and conditional formatting when extending a workbook.
5. Set recalculation flags when formulas change:

   ```python
   workbook.calculation.fullCalcOnLoad = True
   workbook.calculation.forceFullCalc = True
   workbook.calculation.calcMode = "auto"
   ```

6. Use a single reusable builder script in `$CWW_JOB_RUNTIME`; patch and rerun it instead of creating multiple variants.

## Verify before delivery

1. Reopen the saved workbook with `data_only=False` and verify requested sheets, dimensions, keys, row counts, formulas, formats, and totals.
2. Run `scripts/workbook_qa.py` from this skill with the managed Python interpreter. Treat archive corruption, empty sheets, or formula-error literals as blockers.
3. For created or visually changed workbooks, render a temporary copy through headless LibreOffice, convert the PDF pages to PNG with `pdftoppm`, and inspect every sheet. Fix clipped headers, unreadable widths, broken charts, awkward wrapping, and blank default sheets.
4. For important computed results, reconcile representative totals independently in Python. Do not claim formula results were recalculated if only `openpyxl` was used.
5. Deliver only the final spreadsheet filename(s); do not expose builders, QA JSON, previews, temporary conversions, or absolute server paths.

## Preserve safely

- Complex Excel features such as pivot caches, slicers, external connections, signatures, and some drawing objects may not round-trip through `openpyxl`. Inspect warnings and use the smallest possible edit; report a blocker rather than silently stripping critical features.
- Never enable or run workbook macros, external links, DDE, or embedded executables.
- Never install packages into the shared runtime. If a requested capability is missing, use the provided temporary Python runner or explain the limitation.
