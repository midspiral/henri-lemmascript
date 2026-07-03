#!/usr/bin/env bash
# The reflection gate — the only sanctioned door for a self-improvement.
#
#   scripts/gate.sh                  dry run: check a proposed improvement
#   scripts/gate.sh --adopt "<msg>"  ...and on green, commit it (adoption;
#                                    takes effect on the next launch)
#
# Order: past → present → behavior → freeze.
#   1  the past is immutable — seal-check against the ledger AS COMMITTED AT
#      HEAD, so tampering with the working-copy SEALED.lock is inert
#   2  every self core is registered — a self/core file missing from
#      LemmaScript-files.txt would load unverified and unfrozen
#   3  the present is proven — lsc regen + Dafny over the whole file list
#   4  behavior — typecheck + tests
#   5  freeze — rebuild the ledger from HEAD and append the new guarantees
#      (append-only by construction: seal REFUSES any changed frozen contract),
#      then strict-check that nothing verified remains unfrozen
set -euo pipefail
cd "$(dirname "$0")/.."

export LEMMASCRIPT="${LEMMASCRIPT:-../LemmaScript}"
seal() { npx tsx ../lemmascript-seal/src/cli.ts "$@"; }

step() { printf '\n── gate %s\n' "$1"; }
red() { printf '\nGATE RED — %s\n' "$1"; exit 1; }

step "1/5 the past is immutable (seal-check vs HEAD ledger)"
if git cat-file -e HEAD:SEALED.lock 2>/dev/null; then
  headlock=$(mktemp)
  trap 'rm -f "$headlock"' EXIT
  git show HEAD:SEALED.lock > "$headlock"
  seal check --lock "$headlock" || red "a frozen guarantee was weakened or removed"
else
  echo "(bootstrap: no SEALED.lock at HEAD yet — checking working-tree ledger)"
  seal check || red "a frozen guarantee was weakened or removed"
fi

step "2/5 every self core is registered"
found_any=0
for f in self/core/*.ts; do
  [ -e "$f" ] || continue
  found_any=1
  awk -v f="$f" '$1 == f { found = 1 } END { exit !found }' LemmaScript-files.txt \
    || red "$f is not registered in LemmaScript-files.txt"
done
[ "$found_any" = 1 ] && echo "all self cores registered" || echo "(no self cores yet)"

step "3/5 the present is proven (lsc regen + Dafny)"
npm run verify || red "the prover rejected the current contracts"

step "4/5 behavior (typecheck + tests)"
npm run typecheck || red "typecheck failed"
npm test || red "tests failed"

step "5/5 freeze the new guarantees (append-only)"
if git cat-file -e HEAD:SEALED.lock 2>/dev/null; then
  git show HEAD:SEALED.lock > SEALED.lock   # working lock := HEAD + appends, by construction
fi
seal seal || red "seal refused — a frozen contract changed"
seal check --strict || red "a verified symbol is not frozen"

printf '\nGATE GREEN\n'

if [ "${1:-}" = "--adopt" ]; then
  msg="${2:-self-improvement (gate green)}"
  git add -A
  git commit -m "$msg"
  printf 'adopted %s — takes effect on the next launch\n' "$(git rev-parse --short HEAD)"
fi
