#!/usr/bin/env bash
#
# validate-release-tag.sh — reject deploy tags that were not cut properly.
#
# PORTED from the fuse-laravel app (my/scripts/validate-release-tag.sh) so both
# repos enforce one release convention. Keep them in step -- a divergence here
# means two repos that look like they share a scheme and do not. The only
# intended differences are noted inline.
#
#   scripts/validate-release-tag.sh v2026.08.05.01
#
# The tag IS the deploy trigger, so anyone who can push a matching tag can
# deploy — via the Forgejo web UI, the API, or a plain `git push`. Any check that
# runs on the client is therefore advisory. This script is
# where those checks are actually enforced, which is why it runs as the first
# step of every tag-triggered pipeline: before build, before test, before any
# AWS credential is issued. A bad tag fails in seconds instead of after the
# full suite.
#
# Three rules:
#
#   shape    strictly <prefix>YYYY.MM.DD.NN. The pipeline glob 'v20*' is far
#            looser than the scheme — it happily matches v2026.8.5.1 or
#            v20-hotfix. This is the only place the real format is enforced.
#
#   ceiling  the date may not be later than tomorrow (UTC). One day of slack
#            covers a deployer whose local date is ahead of UTC; deploy.sh
#            stamps tags with local dates. Without this, v2099.12.31.99 parks
#            itself at the top of the list forever.
#
#   ratchet  must sort strictly above every VALID existing tag of the same
#            prefix. This is what rejects back-dated tags like v2025.06.04.01.
#
# Two things worth understanding about the ratchet:
#
#   It compares tag NAMES, not commits, so it stays fully compatible with
#   rollbacks — rolling back cuts a new, higher-numbered tag on an older
#   commit. The code moves backward while the tag moves forward.
#
#   The baseline deliberately excludes tags that fail shape or ceiling. If a
#   bogus far-future tag is pushed, this step blocks its deploy but cannot
#   delete it, and a naive ratchet would then reject every legitimate tag from
#   then on. Filtering the baseline means one bad push can't wedge deploys.
#
# Plain `sort` is correct here, no `sort -V` required: every field is
# fixed-width and zero-padded, so lexical and numeric order agree. That is
# precisely why deploy.sh pads the sequence to two digits.

set -euo pipefail

TAG="${1:?usage: validate-release-tag.sh <tag>}"
REMOTE="${REMOTE:-origin}"

die() { printf 'tag-guard: %s\n' "$*" >&2; exit 1; }

case "$TAG" in
  dev20*) PREFIX="dev" ENVNAME="dev" ;;
  v20*) PREFIX="v" ENVNAME="prod" ;;
  *) die "'$TAG' is not a deploy tag (expected v20… or dev20…)" ;;
esac

# GNU/busybox take -d @epoch; BSD/macOS takes -r epoch. deploy.sh may call this
# on a laptop, the pipeline calls it in alpine, so handle both.
if date -u -d "@0" +%Y >/dev/null 2>&1; then
  utc_day() { date -u -d "@$(($(date -u +%s) + ($1 * 86400)))" +%Y.%m.%d; }
else
  utc_day() { date -u -r "$(($(date -u +%s) + ($1 * 86400)))" +%Y.%m.%d; }
fi

TOMORROW="$(utc_day 1)"

is_well_formed() {
  printf '%s' "$1" \
    | grep -qE "^${PREFIX}20[0-9]{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[0-9]{2}$"
}

tag_date() { printf '%s' "${1#"$PREFIX"}" | cut -d. -f1-3; }

# --- shape ------------------------------------------------------------------
is_well_formed "$TAG" \
  || die "'$TAG' is malformed. Expected ${PREFIX}YYYY.MM.DD.NN, zero-padded (e.g. ${PREFIX}$(utc_day 0).01). Cut tags with the documented scheme, not by hand."

# --- ceiling ----------------------------------------------------------------
if [ "$(tag_date "$TAG")" \> "$TOMORROW" ]; then
  die "'$TAG' is dated in the future (ceiling is $TOMORROW UTC). A future-dated tag would sit at the top of the release list indefinitely."
fi

# --- ratchet ----------------------------------------------------------------
# ls-remote needs no history, so this stays cheap on a shallow clone.
HIGHEST=""
while read -r ref; do
  [ -n "$ref" ] || continue
  candidate="${ref#refs/tags/}"
  case "$candidate" in *"^{}") continue ;; esac      # annotated-tag deref lines
  [ "$candidate" = "$TAG" ] && continue
  is_well_formed "$candidate" || continue            # ignore junk in the baseline
  [ "$(tag_date "$candidate")" \> "$TOMORROW" ] && continue
  if [ -z "$HIGHEST" ] || [ "$candidate" \> "$HIGHEST" ]; then
    HIGHEST="$candidate"
  fi
done <<EOF
$(git ls-remote --tags "$REMOTE" "refs/tags/${PREFIX}20*" | awk '{print $2}')
EOF

if [ -n "$HIGHEST" ] && ! [ "$TAG" \> "$HIGHEST" ]; then
  die "'$TAG' does not move forward — the current highest release is '$HIGHEST'. To ship an older commit, cut a NEW higher tag on it (./deploy.sh $ENVNAME <commit>), don't back-date."
fi

echo "tag-guard: $TAG ok (previous: ${HIGHEST:-none}, ceiling: $TOMORROW UTC)"
