Your distill content lives in the git worktree at {{worktreePath}}. Use `git -C {{worktreePath}}` for all git operations there — your shell cwd is NOT the worktree. Edit files in the worktree by absolute path under `{{worktreePath}}/...` (or `cd {{worktreePath}}` first if your tool supports it).

Edit files only inside `{{worktreePath}}`, and do not edit files under `{{vaultPath}}` or run git against `{{vaultPath}}` at all. The wrapper that invoked you lands your branch on `{{defaultBranch}}` itself: it catches the branch up, drops changes to the vault's read-only notes, squashes, pushes and cleans up. Your job ends at step 7 with a committed distill branch.

Distill this conversation into the napkin vault.

1. `napkin overview` — learn the vault structure and what exists. Read `_about.md` files to understand what each folder is for. These are short folder descriptions (1-2 paragraphs) explaining what kinds of notes belong there — see existing ones for style.
2. `napkin template list` and `napkin template read` — learn the note formats.
3. Identify what's worth capturing. The vault structure and templates tell you what kinds of notes belong.
4. For each note:
   a. `napkin search` for the topic — if a note already covers it, `napkin append` instead of creating a duplicate
   b. Create new notes with `napkin create`, following the template format; use the relevant folder path
   c. Add `[[wikilinks]]` to related notes
5. Append a brief summary of key activities and decisions to today's daily note in the relevant namespace (e.g. `{namespace}/daily/YYYY-MM-DD.md`). Follow existing patterns. Create it if it doesn't exist.
6. Frontmatter convention: when you create a note that replaces an older one, add `supersedes: ["path/to/old/note.md"]` to its frontmatter. A future janitor will archive the superseded note. Leave the field empty or omit it for notes that stand alone.

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.

Notes matching the vault's read-only list (PR and issue notes) are projection sources, maintained by the tools that own them: do not edit, create or delete them, and do not work around that by editing the file in place. When you have a finding about a PR or an issue, put it in the namespace's changelog, reflections or daily note and link the PR note instead.

7. Commit and merge in the worktree. If you decided nothing in this conversation merits capturing (per "Be selective" above), skip step 7 entirely and exit — the wrapper will classify this as `no-content` and surface a warning to the user. Otherwise, from the worktree at {{worktreePath}}, commit your distilled content first if you haven't already:

       git -C {{worktreePath}} add -A
       git -C {{worktreePath}} commit -m "distill: <one-line summary>"

   Then merge {{defaultBranch}} into your distill branch:

       git -C {{worktreePath}} merge --no-edit {{defaultBranch}}

   `--no-edit` accepts git's auto-generated merge commit message non-interactively; without it, git would open `core.editor` on a clean auto-merge and your bash tool (which has no TTY) would hang or fail.

   If conflicts arise, you will see files with standard `<<<<<<<`, `=======`, `>>>>>>>` markers. Resolve each by editing the file in place to produce the correct merged content. Use the conversation history above to inform your choices — you have full context on what content you intended to add. Once all markers are gone:

       git -C {{worktreePath}} add .
       git -C {{worktreePath}} commit --no-edit

   If `git -C {{worktreePath}} merge --no-edit {{defaultBranch}}` reports "Already up to date" (no merge commit), that's fine — proceed. Never commit a file that still contains conflict markers: the wrapper refuses any run whose branch adds marker lines, and keeps the branch for a human to inspect.

   The only branch you may create or move is `{{branchName}}`. Do not create landing branches (no `distill-land/*`, no per-attempt variants) and never write or rewrite any ref with plumbing: `git update-ref`, `git branch -f`, `git checkout -B` / `git switch -C`, `git reset`, `git rebase`, `git commit --amend`, `git merge --squash`, `git push` and `git fetch . <src>:<dst>` are forbidden on any branch. The wrapper is the only thing that lands your content on `{{defaultBranch}}`. If the merge cannot be completed with the commands above, stop and report the failure — do not improvise a workaround.

Report progress concisely as you go. Stop after step 7 — the wrapper lands your branch.
