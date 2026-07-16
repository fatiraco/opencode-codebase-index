# Symbol indexing

Add `symbolIndexing` to `.opencode/codebase-index.json`.

```json
{
  "symbolIndexing": {
    "rules": [
      {
        "file": "Frontend/project/eng-app/eng-app-trunk/src/app/page-def.ts",
        "include": [
          "PageDef"
        ],
        "includeChildren": true,
        "includeReferencedSymbols": false
      }
    ]
  }
}
```

Rules:

- Files without a matching rule are indexed normally.
- `file` is relative to the project root. Both `/` and `\\` are accepted.
- `include` must contain at least one symbol name.
- `includeChildren` defaults to `true` and retains chunks contained in the selected symbol range.
- `includeReferencedSymbols` currently supports only `false`. Referenced symbols must be added explicitly.
- After changing a rule, run a full reindex so existing chunks are replaced.
