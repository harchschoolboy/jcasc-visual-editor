# JCasC Visual Editor

A browser editor for the `jenkins.views`, `jenkins.authorizationStrategy`
(role-based) and `credentials` blocks of a Jenkins
Configuration-as-Code file. It needs no build step and no server.

## Run

Open `index.html` in Chrome or Edge. Opening it from `file://` works. Saving
straight to disk uses the File System Access API, so it needs a Chromium-based
browser. Other browsers can still use **Download** and **Copy**.

## Workflow

1. **Open JCasC…** to load a file from disk, or **Paste…** to paste YAML text.
2. **Jobs folder…** to pick the folder of Job DSL scripts, for example
   `jenkins/jobs`. Every `*.groovy` file is scanned for
   `pipelineJob('…')`, `freeStyleJob('…')`, `folder('…')` and similar calls.
   Credential references such as `credentialsId`, `credentials('…')` and
   `string(credentialsId: …)` are also collected.
   - If no JCasC file is loaded yet, the first YAML file with a    `jenkins`, `credentials` or `unclassified` section in the picked folder tree is opened automatically.
     Files with `jcasc` or `casc` in the name are tried first.
   - Subfolders named like `deprecated`, `archive`, `old` or `backup` are
     excluded by default. Change this from the **Jobs: …** menu.
   - You can also drag and drop a folder or file onto the page.
3. **Views** tab:
   - The tabs and job table look like the Jenkins dashboard. Drag a tab to
     reorder it, drop a job onto a tab to add it, and use **+** to add a view.
   - The table shows which jobs a view matches and why: `name` means the job is
     listed in `jobNames`, `regex` means it matches `includeRegex`, and
     `not found` means the job is listed but no such job exists.
   - **Jobs not in any list view** shows jobs that no list view covers.
   - The form on the right edits name, type, description, includeRegex (with a
     live match count), jobNames, columns, recurse and any other YAML
     properties.
4. **Credentials** tab: a filterable table and a per-credential form. The form
   has a type-specific field editor, a "Used by" list, and duplicate, move and
   delete actions.
5. **Roles** tab (`jenkins.authorizationStrategy.roleBased`, the role-strategy
   plugin) instead of the per-role `entries` lists:
   - **Users × Roles** matrix: one row per user or group, one column per role,
     tick to grant. **Merge same-named roles** shows the global and items roles
     that share a name (for example `qa` and `Q - .*`) as one column. A
     half-ticked cell means the user has only part of that pair. The **Jobs**
     column shows how many scanned jobs the user can read.
   - **Roles × Permissions** matrix: one row per permission, grouped by
     category. Cells that don't apply to the role type are hatched.
   - Click a user to rename them everywhere, remove them from all roles, copy
     the roles of another user, and see effective access per job. Click a role
     to edit its type, name, pattern (with matching jobs), permissions and
     members. New users can be added with "same roles as …".
6. The **Code** panel on the right can be collapsed. It shows the full file
   with an inline diff, only the changed hunks, or a single section.
   **Checks** at the bottom list problems such as duplicate view names or
   credential IDs, missing jobs, regex-like entries in `jobNames`, plain-text
   secrets, unused or undefined credentials, roles without permissions or
   members, unknown permissions, item patterns that match no job, and users
   with item roles but no global `Overall/Read`.
7. **Save** (Ctrl+S) writes back to the opened file. **Download** and
   **Copy** export the result. Ctrl+Z and Ctrl+Y undo and redo.

## How exporting works

Only the `jenkins.views`, `jenkins.viewsTabBar`,
`jenkins.authorizationStrategy` and `credentials` blocks that
you actually changed are regenerated. They are spliced back into the original
text, so comments and formatting everywhere else stay exactly as they were.
Quote style, blank lines between entries and line endings follow the
original. The session is stored in `localStorage`.

## Limitations

- View matching follows Jenkins `ListView`: `jobNames` match case-insensitively
  and `includeRegex` must match the whole name. `jobFilters` and
  `statusFilter` are kept but not evaluated.
- Jobs are found by static regex scanning of Groovy. Names that are computed
  at runtime are not detected.
- Comments inside a regenerated block are not preserved.
- Role item patterns are checked against scanned job names. Agent patterns
  are not checked. Only the `roleBased` strategy is editable, and other
  strategies are shown read-only.

## Development

```sh
npm install
npm test          # core logic tests (node:test)
npm run vendor    # rebuild vendor/yaml.min.js from the yaml package
```

`src/core.js` contains all the pure logic: parsing, generation, splicing,
matching and lint. The `src/app-*.js` files are the UI and load in the order
listed in `index.html`.
