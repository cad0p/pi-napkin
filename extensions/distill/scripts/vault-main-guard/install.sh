#!/bin/sh
# SPDX-License-Identifier: MIT
# Part of @cad0p/pi-napkin - install the vault-main-guard hook.
#
# Installs the reference-transaction hook that keeps refs/heads/main in a
# shared vault fast-forward-only and undeletable. The hook refuses, in the
# "prepared" transaction state:
#   * deleting refs/heads/main;
#   * any new tip that is not a descendant of the current tip.
# Fast-forwards, merges and the initial creation of main pass.
#
# Usage:
#   install.sh [--repo PATH] [--dry-run]
#
# --repo PATH   repository/worktree to install into (default: current dir)
# --dry-run     print the resolved hooks dir and planned action, change nothing
#
# Hooks dir resolution: core.hooksPath when set (absolute, or relative to the
# repository top level), otherwise the common git dir's hooks/ - the same
# directory git uses for linked worktrees.
#
# Existing hooks are preserved:
#   * git-lfs hooks (post-checkout, post-commit, post-merge, pre-push) are
#     never touched - they are different hook names;
#   * an existing reference-transaction hook is moved to
#     reference-transaction.pre-vault-main-guard and chained: its stdin
#     (which cannot be replayed by calling two hooks) is buffered once and
#     fed to the old hook first, then to the guard. If the old hook fails,
#     the transaction is aborted exactly as before.
#
# Re-running the installer updates the guard in place and keeps a chained
# hook chained.
#
# This script is optional: the hook is a plain POSIX sh file and can be
# copied into <hooks>/reference-transaction by hand.

set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOOK_SRC="$SELF_DIR/reference-transaction"
MARKER='# marker: vault-main-guard'
CHAIN_MARKER='# vault-main-guard: chain wrapper'
GUARD_COPY_NAME='reference-transaction.vault-main-guard'
BACKUP_NAME='reference-transaction.pre-vault-main-guard'

usage() {
	printf '%s\n' \
		"usage: install.sh [--repo PATH] [--dry-run]" \
		"" \
		"Installs the vault-main-guard reference-transaction hook that keeps" \
		"refs/heads/main fast-forward-only and undeletable."
}

repo=''
dry_run=0
while [ $# -gt 0 ]; do
	case "$1" in
	--repo)
		[ $# -ge 2 ] || { printf '%s\n' "install.sh: --repo needs a value" >&2; exit 2; }
		repo=$2
		shift 2
		;;
	--dry-run)
		dry_run=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf '%s\n' "install.sh: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

[ -f "$HOOK_SRC" ] || { printf '%s\n' "install.sh: hook source not found: $HOOK_SRC" >&2; exit 1; }

[ -n "$repo" ] || repo=$(pwd)
[ -d "$repo" ] || { printf '%s\n' "install.sh: no such directory: $repo" >&2; exit 1; }

common_dir=$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null) ||
	{ printf '%s\n' "install.sh: not a git repository: $repo" >&2; exit 1; }
case "$common_dir" in
/*) : ;;
*) common_dir="$repo/$common_dir" ;;
esac
common_dir=$(CDPATH= cd -- "$common_dir" && pwd)

hooks_path=$(git -C "$repo" config --get core.hooksPath 2>/dev/null || true)
if [ -n "$hooks_path" ]; then
	case "$hooks_path" in
	/*) hooks_dir=$hooks_path ;;
	*)
		top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$repo")
		hooks_dir="$top/$hooks_path"
		;;
	esac
	hooks_source="core.hooksPath ($hooks_path)"
else
	hooks_dir="$common_dir/hooks"
	hooks_source='common git dir'
fi

target="$hooks_dir/reference-transaction"
guard_copy="$hooks_dir/$GUARD_COPY_NAME"
backup="$hooks_dir/$BACKUP_NAME"

mode=plain
if [ -e "$target" ]; then
	if grep -q "^$CHAIN_MARKER" "$target" 2>/dev/null; then
		mode=chain
		if [ ! -e "$backup" ]; then
			printf '%s\n' "install.sh: $target is a chain wrapper but $backup is missing; refusing to guess" >&2
			exit 1
		fi
	elif grep -q "^$MARKER" "$target" 2>/dev/null; then
		mode=plain
	else
		mode=chain
		if [ -e "$backup" ]; then
			printf '%s\n' "install.sh: refusing to overwrite existing $backup (a previous install left a chained hook behind)" >&2
			exit 1
		fi
	fi
fi

if [ "$dry_run" -eq 1 ]; then
	printf '%s\n' \
		"vault-main-guard: dry run" \
		"  repo:      $repo" \
		"  hooks dir: $hooks_dir [$hooks_source]" \
		"  target:    $target" \
		"  action:    $mode"
	exit 0
fi

mkdir -p "$hooks_dir"

if [ "$mode" = chain ]; then
	if [ ! -e "$backup" ]; then
		mv "$target" "$backup"
	fi
	cp "$HOOK_SRC" "$guard_copy"
	chmod 755 "$guard_copy"
	cat >"$target" <<'WRAPPER'
#!/bin/sh
# vault-main-guard: chain wrapper
#
# The pre-existing reference-transaction hook could not be called after the
# guard: both hooks read the transaction from stdin, and stdin cannot be
# replayed. Buffer it once, feed the old hook first (its exit status still
# aborts the transaction), then feed the guard.
set -u
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
umask 077
tmp=$(mktemp "${TMPDIR:-/tmp}/vault-main-guard.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat >"$tmp"
if [ -x "$dir/reference-transaction.pre-vault-main-guard" ]; then
	"$dir/reference-transaction.pre-vault-main-guard" "$@" <"$tmp" || exit $?
fi
"$dir/reference-transaction.vault-main-guard" "$@" <"$tmp"
rc=$?
rm -f "$tmp"
trap - EXIT HUP INT TERM
exit "$rc"
WRAPPER
	chmod 755 "$target"
	sh -n "$target"
	sh -n "$guard_copy"
	printf '%s\n' \
		"vault-main-guard: installed $target [$hooks_source]" \
		"  chained pre-existing hook: $backup"
else
	cp "$HOOK_SRC" "$target"
	chmod 755 "$target"
	sh -n "$target"
	printf '%s\n' \
		"vault-main-guard: installed $target [$hooks_source]" \
		"  guards refs/heads/main: no delete, no non-fast-forward move"
fi
