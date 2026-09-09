#!/usr/bin/env bash
# pii-gauntlet.sh — verify no PII leaked into plessas-marketplace.
#
# TWO MODES:
#   --mode=ci      Scan only git-tracked files. Used by GitHub Actions to gate
#                  pushes. Any hit = FAIL = exit 1.
#   --mode=doctor  (default) Scan the entire working tree. Distinguishes tracked
#                  hits (FAIL — these would ship publicly) from gitignored hits
#                  (INFO — local-only, never pushed). Exit 1 only on tracked hits.
#
# Why two modes:
#   The CI mode is the actual safety gate.
#   The doctor mode helps the maintainer notice PII drift in their LOCAL files
#   before they accidentally `git add` something. It must NOT scare a teammate
#   running the script casually — "FAIL" on a gitignored file would teach them
#   to ignore the script entirely, defeating the point.
#
# Self-exclusion: this script contains the very patterns it searches for, so
# `--exclude=pii-gauntlet.sh` is essential to avoid self-match false positives.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Default to CI mode on a runner. Three repositories invoke this script with no
# --mode flag at all, so they got doctor mode, which fails hard when the private
# denylist is absent -- and on a runner it is always absent. Keying off the
# environment rather than the caller means a workflow cannot get this wrong by
# omission. GitHub, GitLab and most others set CI=true.
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  MODE="ci"
else
  MODE="doctor"
fi
_MODE_FROM_ENV="$MODE"
for arg in "$@"; do
  case "$arg" in
    --mode=ci)     MODE="ci" ;;
    --mode=doctor) MODE="doctor" ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "=== PII Gauntlet (mode: $MODE) ==="
echo "Repo: $REPO_ROOT"
echo

FAIL=0
INFO=0

# This script's path relative to the repo root. Derived, not hardcoded: the
# same file lives in installers/ in some repos and scripts/ in others, and
# hand-maintained copies are what let them drift apart in the first place.
# Both modes need it now, so it is computed before either branch.
SELF_REL=$(git ls-files --full-name -- "$0" 2>/dev/null | head -1)
[ -z "$SELF_REL" ] && SELF_REL="scripts/pii-gauntlet.sh"

# Build the file list once. CI mode = tracked only. Doctor mode = working tree.
if [ "$MODE" = "ci" ]; then
  # Exclude self + auto-generated lockfiles at any depth (lockfiles contain SHAs / hashes that
  # collide with the 9-digit-ID regex but carry no PII risk).
  TRACKED=$(git ls-files \
    | grep -v "^$SELF_REL$" \
    | grep -vE '(^|/)LICENSE(\.md|\.txt)?$' \
    | grep -vE '(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock)$' \
    || true)
  TRACKED_TMP=$(mktemp)
  printf '%s\n' "$TRACKED" > "$TRACKED_TMP"
fi

# Helper: get the tracked-vs-untracked status of a file.
file_is_tracked() {
  git ls-files --error-unmatch "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# The tracked TREE, as distinct from file CONTENTS
# ---------------------------------------------------------------------------
#
# Neither mode could see a FILENAME. Both grep file CONTENTS, and both skip
# binaries, so for a .png or an .ogg the name is the only readable surface
# there is. In the marketplace copy of this script that blind spot hid two
# tracked files disclosing an internal project name in their own filenames
# while every content check passed and the gate printed GAUNTLET PASS.
#
# TREE_PATHS deliberately includes binaries, for exactly that reason. A
# filename is text no matter what the file contains.
TREE_PATHS=$(git ls-files | grep -v "^$SELF_REL$" || true)
UNTRACKED_PATHS=$(git ls-files --others --exclude-standard 2>/dev/null || true)

# Pair every path with its separator-normalised form as "orig<TAB>normalised",
# so a hit already carries its own path. Matching runs against the whole pasted
# line, so a hit on EITHER form counts, which is the union wanted.
#
# The normalisation matters more than case does. Filenames join words with _ .
# or -, so a pattern written "two words" matches prose and misses Two_words.png.
# Without it this check finds nothing at all, which would make it a check that
# exists only to look reassuring.
#
# One consequence: a `$`-anchored pattern would anchor to the normalised half.
# No pattern in use is `$`-anchored.
#
# Hits are emitted as "path:(filename)" so they share the "path:" shape the
# doctor-mode tracked/untracked splitter already parses.
scan_paths() {
  local pattern="$1"
  local list="$2"
  [ -n "$list" ] || return 0
  paste <(printf '%s\n' "$list") <(printf '%s\n' "$list" | tr '_.-' '   ') \
    | grep -iE "$pattern" 2>/dev/null \
    | cut -f1 \
    | sed 's/$/:(filename)/' \
    || true
}

scan_doctor() {
  local pattern="$1"
  grep -riE \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=__pycache__ \
    --exclude-dir=.venv \
    --exclude-dir=venv \
    --exclude-dir=.remember \
    --exclude-dir=data \
    --exclude-dir=attachments \
    --exclude-dir=backups \
    --exclude-dir=archive \
    --exclude-dir=.next \
    --exclude-dir=dist \
    --exclude-dir=coverage \
    --exclude-dir=installers/deps \
    --exclude=pii-gauntlet.sh \
    --exclude=LICENSE \
    --exclude=LICENSE.md \
    --exclude=LICENSE.txt \
    --exclude=PII-GAUNTLET.md \
    --exclude=package-lock.json \
    --binary-files=without-match \
    "$pattern" . 2>/dev/null \
    || true
}

scan_ci() {
  local pattern="$1"
  # Search only git-tracked files. NUL-delimit the list and use `xargs -0`
  # (portable on BSD/macOS and GNU). The old `xargs -a FILE -d '\n'` form is
  # GNU-only: on macOS it errors "invalid option -- a", gets swallowed by
  # 2>/dev/null, and the gate silently PASSES while scanning nothing.
  # -i, matching scan_doctor above. Without it the GATE was case-sensitive
  # while the local doctor was not, so the check that blocks a push was the
  # weaker of the two, which is backwards.
  if [ -s "$TRACKED_TMP" ]; then
    tr '\n' '\0' < "$TRACKED_TMP" | xargs -0 grep -inE --binary-files=without-match "$pattern" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# The case-SENSITIVE scan path -- the third one, beside scan_doctor and scan_ci
# ---------------------------------------------------------------------------
#
# scan_doctor and scan_ci both pass -i and both must keep it. Folding case is
# right for a mail domain and a tenant host, and adding it to scan_ci is what
# closed the gap where the push GATE was weaker than the local doctor. But an
# ALL-CAPS Greek personal name is a SHAPE, and -i turns "two capitalised Greek
# words" into "two Greek words", which matches ordinary Greek prose. Relaxing
# either existing scanner to host that rule would trade a real catch for a
# shape one. So there is a third path instead, and these two are the exact
# twins of scan_ci and scan_paths, differing only in the missing -i.
#
# CS_FILES is the part neither twin has. A grep over an empty file list prints
# nothing and exits 1, which is indistinguishable from a clean tree, and this
# file has shipped that exact false green before: it once reported OK on every
# check while, on macOS, scanning zero files. The count is printed on every run
# and check_shape refuses to report OK when it is zero.
#
# Doctor mode adds untracked-but-not-ignored files, so the population is
# exactly "everything that could ship". It therefore never emits INFO, unlike
# the -i checks, which also read gitignored files. Ignored files are dropped by
# --exclude-standard rather than by a hand-maintained --exclude-dir list, so
# the two cannot drift apart.
#
# core.quotePath=false on every one of these, and it is load-bearing. By
# default `git ls-files` renders a non-ASCII path as a quoted C string of octal
# bytes, "\316\244\316\225...", so TREE_PATHS above cannot see a Greek filename
# at all, and worse, a Greek-named file's CONTENTS are never opened either:
# xargs hands grep a filename that does not exist and the error goes to
# /dev/null. That hole is pre-existing and shared by the -i checks, which are
# left alone here. A Greek-name check that inherited it would be structurally
# blind to the one filename it exists to catch. Set per invocation, never in
# the repo's config, so nothing outside this script changes.
CS_TREE_PATHS=$(git -c core.quotePath=false ls-files | grep -v "^$SELF_REL$" || true)
CS_UNTRACKED_PATHS=$(git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null || true)
CS_LIST_TMP=$(mktemp)
{
  git -c core.quotePath=false ls-files
  [ "$MODE" = "doctor" ] && git -c core.quotePath=false ls-files --others --exclude-standard
} 2>/dev/null \
  | grep -v "^$SELF_REL$" \
  | grep -vE '(^|/)LICENSE(\.md|\.txt)?$' \
  | grep -vE '(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock)$' \
  | grep -v '^$' \
  | sort -u > "$CS_LIST_TMP"
CS_FILES=$(grep -c . "$CS_LIST_TMP" 2>/dev/null || true)

scan_cs() {
  local pattern="$1"
  [ -s "$CS_LIST_TMP" ] || return 0
  # -H, which scan_ci does without: a final xargs batch of exactly one file
  # makes grep omit the path, and the doctor-mode splitter parses the path off
  # the front of every line.
  tr '\n' '\0' < "$CS_LIST_TMP" | xargs -0 grep -HnE --binary-files=without-match "$pattern" 2>/dev/null || true
}

scan_paths_cs() {
  local pattern="$1"
  local list="$2"
  [ -n "$list" ] || return 0
  paste <(printf '%s\n' "$list") <(printf '%s\n' "$list" | tr '_.-' '   ') \
    | grep -E "$pattern" 2>/dev/null \
    | cut -f1 \
    | sed 's/$/:(filename)/' \
    || true
}

# Which scan path a check uses, decided in one place per mode so that all three
# are visible together. An empty $scanner is every pre-existing caller and
# selects the case-insensitive pair exactly as before; "shape" selects the
# case-sensitive twins above.
gather_ci() {
  local scanner="$1"
  local pattern="$2"
  if [ "$scanner" = "shape" ]; then
    printf '%s\n%s' "$(scan_cs "$pattern")" "$(scan_paths_cs "$pattern" "$CS_TREE_PATHS")"
  else
    printf '%s\n%s' "$(scan_ci "$pattern")" "$(scan_paths "$pattern" "$TREE_PATHS")"
  fi | grep -v '^$' || true
}

gather_doctor() {
  local scanner="$1"
  local pattern="$2"
  # scan_cs already covers untracked CONTENT here, because CS_LIST_TMP is built
  # with --others in doctor mode. Only the untracked PATHS need a second pass,
  # mirroring the case-insensitive branch below it.
  if [ "$scanner" = "shape" ]; then
    printf '%s\n%s\n%s' \
      "$(scan_cs "$pattern")" \
      "$(scan_paths_cs "$pattern" "$CS_TREE_PATHS")" \
      "$(scan_paths_cs "$pattern" "$CS_UNTRACKED_PATHS")"
  else
    printf '%s\n%s\n%s' \
      "$(scan_doctor "$pattern")" \
      "$(scan_paths "$pattern" "$TREE_PATHS")" \
      "$(scan_paths "$pattern" "$UNTRACKED_PATHS")"
  fi | grep -v '^$' || true
}

# Drop hits that are documentation rather than live configuration.
#
# Two kinds of exclusion, and they are NOT interchangeable:
#   $2 content: matched anywhere on the grep line. Keep it narrow and literal,
#      because a broad content exclusion is indistinguishable from switching the
#      check off.
#   $3 path: matched against the `path:` prefix only. A path-shaped pattern let
#      loose on the whole line also matches CONTENT, which is how `<[^>]+>`
#      silently excluded every line carrying an HTML tag.
#
# There used to be a global PLACEHOLDER_PATH='example|sample|template' applied
# here to every caller. Unanchored and matched as a substring against the path
# of every hit, it exempted whole FILES rather than placeholder values: three
# tracked files were invisible to every check, .env.example,
# bridge/launchd/com.weirdapps.telegram-claude-bridge.plist.template and
# test_scripts/send-voice-samples.ts. An .env example is exactly the file a real
# token or chat id gets pasted into. It is gone; the one legitimate placeholder
# it was covering is now excluded by VALUE, at the denylist loop below.
apply_exclusion() {
  local hits="$1"
  local exclude="$2"
  local exclude_path="${3:-}"
  # No early return, and no filter that only some callers get. The old version
  # short-circuited when $exclude was empty, which is not a corner case here:
  # it is why "Owner full name (EN)" reports the README copyright line today
  # while "Full personal name (EN)", whose denylist entry has a non-empty
  # exclude, has the identical hit silently dropped. Two checks, one line,
  # opposite verdicts, decided by whether a field in another file was blank.
  #
  # That third filter dropped any line containing "(c) YYYY" or the word
  # "copyright", case-insensitively, in the name of licence attribution.
  # LICENSE, LICENSE.md and LICENSE.txt are already removed from the file list
  # in both modes, so it protected nothing and instead handed anyone a one-word
  # suppression token: "Copyright 2026 - reach me at <real address>" was dropped
  # silently while the same address without the word was caught. It is gone.
  if [ -n "$hits" ] && [ -n "$exclude_path" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "^[^:]*($exclude_path)" || true)
  fi
  if [ -n "$hits" ] && [ -n "$exclude" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$exclude" || true)
  fi
  printf '%s' "$hits"
}

check() {
  local label="$1"
  local pattern="$2"
  local exclude="${3:-}"
  local exclude_path="${4:-}"
  # Fifth argument selects the SCAN PATH. Empty, which is every pre-existing
  # caller, means the case-insensitive pair; "shape" means the case-sensitive
  # twins. Nothing about the -i scanners changes; this only chooses between
  # them and their twins.
  local scanner="${5:-}"
  local hits

  if [ "$MODE" = "ci" ]; then
    # Contents AND filenames, in one verdict per check. Folding them together
    # rather than bolting on a separate section is deliberate: it means a check
    # added later cannot silently skip the tree, which is the shape of every
    # hole found in this file.
    hits=$(gather_ci "$scanner" "$pattern")
    hits=$(apply_exclusion "$hits" "$exclude" "$exclude_path")
    if [ -n "$hits" ]; then
      echo "FAIL [$label]:"
      echo "$hits" | head -20
      echo
      FAIL=1
    else
      echo "OK   [$label]"
    fi
    return
  fi

  # Doctor mode — separate tracked from gitignored.
  #
  # Untracked FILENAMES are included here and not in CI, matching how doctor
  # already treats untracked CONTENT: an untracked path never ships, so it is
  # INFO rather than FAIL, but doctor exists to surface local drift before
  # someone stages it.
  hits=$(gather_doctor "$scanner" "$pattern")
  hits=$(apply_exclusion "$hits" "$exclude" "$exclude_path")
  if [ -z "$hits" ]; then
    echo "OK   [$label]"
    return
  fi

  local tracked_hits=""
  local untracked_hits=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # line format: ./path/to/file:matched-text
    local path="${line%%:*}"
    path="${path#./}"
    if file_is_tracked "$path"; then
      tracked_hits+="$line"$'\n'
    else
      untracked_hits+="$line"$'\n'
    fi
  done <<< "$hits"

  if [ -n "$tracked_hits" ]; then
    echo "FAIL [$label]:                 (tracked — would ship publicly)"
    printf '%s' "$tracked_hits" | head -20
    echo
    FAIL=1
  fi
  if [ -n "$untracked_hits" ]; then
    echo "INFO [$label]:                 (gitignored / untracked — local-only)"
    printf '%s' "$untracked_hits" | head -10
    echo
    INFO=1
  fi
  if [ -z "$tracked_hits" ] && [ -z "$untracked_hits" ]; then
    echo "OK   [$label]"
  fi
}

# The only caller of the case-sensitive pair, and the only check that reports
# how much it looked at.
#
# The count is not decoration. A check that prints OK without saying whether it
# examined 800 files or none is the defect this file keeps producing, and a
# zero is a broken scan rather than a clean tree, so it is a FAIL.
check_shape() {
  local label="$1"
  if [ "${CS_FILES:-0}" -eq 0 ]; then
    echo "FAIL [$label]: examined 0 files -- the scan did not run, so this is"
    echo "     not a pass. Check that 'git ls-files' works in $REPO_ROOT."
    FAIL=1
    return
  fi
  check "$label" "$2" "${3:-}" "${4:-}" shape
  echo "     (examined $CS_FILES files, case-sensitively)"
}

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Generic organisation tells (safe to keep in a public repo)
# ---------------------------------------------------------------------------
#
# These are patterns, not names, so publishing them discloses nothing. They are
# also the checks that were missing entirely: the four exposures found in the
# 2026-08-24 audit all passed the gauntlet green, because nothing here looked
# for the employer's name, its mail domain, or a tenant hostname.

# Placeholders are the whole point of a good example, so they must not trip the
# check that exists to catch the real thing. Without these excludes the gauntlet
# flags `contoso.sharepoint.com` (the correct placeholder) and its own CHANGELOG
# entries describing the removal of the real host. A check that fires on
# deliberate, already-disclosed content teaches you to ignore it, which is how
# the four real exposures sat unnoticed next to a green gauntlet.
# Doc placeholders, matched against the matched LINE, so every alternative here
# has to be specific enough to name a placeholder and nothing else. Extend this
# when a new invented example trips the check: being asked once "is this real?"
# is the check doing its job, and is a far better failure mode than the silence
# it replaces.
#
# Two entries were removed as unanchored, and both were also unused:
#
#   `user@|name@` were bare substrings, so they exempted `realuser@...` and
#   `firstname@...` as readily as the placeholders they were meant to name.
#   Grepped over the tracked tree, every occurrence here is `name@marketplace`
#   in the plugin-loader docs and code, and not one is an @nbg.gr address, so
#   the mail-domain check could never have fired on one. Dropped rather than
#   anchored, because anchoring would have preserved an exemption for nothing.
#
#   The fixture-host alternation `(test|...|a|b|x|y|z)(-my)?\.sharepoint` named
#   twelve hosts, none of which appears anywhere in this repo: grepped over the
#   tracked tree there is no `.sharepoint.com` string at all outside this
#   script. This is the Telegram bridge; SharePoint is another repo's surface.
#   Every entry was a live exemption guarding nothing, and the single letters
#   are the dangerous shape even when anchored, because one of them being right
#   costs the whole check. If a SharePoint fixture is ever added here, the
#   check will fire on it once; add that one name back anchored with
#   `(^|[^a-z0-9.-])` so it must be a whole host label.
PLACEHOLDER='contoso|your[-_.]?tenant|firstname\.lastname|your\.email|recipient\.name'

# One placeholder VALUE, for the denylist checks below rather than the generic
# ones. `.env.example:35` documents the shape of a bot token as
# `# TELEGRAM_BOT_TOKEN=123456789:AAH...`, and 123456789 trips the denylist's
# 9-digit-id check. That hit was previously suppressed by exempting the whole
# .env.example FILE, which is the hole this commit closes: an .env example is
# exactly where a real token gets pasted. Excluding the value instead keeps the
# rest of the file scanned. It is deliberately the full assignment and not the
# bare digits, so it cannot match anything else in the repo.
PLACEHOLDER_VALUE='TELEGRAM_BOT_TOKEN=123456789'

# A second repo-local VALUE, same mechanism, different reason: the owner's name
# in this repo's own MIT attribution is a deliberate publication, not a leak.
# README.md carries `[MIT](LICENSE), (c) 2026 <name>.` and the denylist's
# owner-name and personal-name checks both fire on it.
#
# The tempting fix, and the one this repo used to ship, is a filter dropping any
# line containing the word "copyright". That was removed because it hands anyone
# a one-word suppression token: put "copyright" on the same line as a real
# address and the scanner goes quiet. This is the narrow version. It requires the
# entire attribution shape, the literal `[MIT](LICENSE), (c) ` followed by a
# four-digit year, so defeating it means writing a fake MIT attribution line into
# a README, which is conspicuous rather than invisible.
#
# It is a VALUE exclusion, not a path exclusion, so the rest of README.md is
# still scanned. Note this only ever fires locally: on a public runner the
# private denylist is absent and every name-based check SKIPs, so CI has always
# been green here. The point is that a local doctor which cries wolf trains
# people to stop reading it.
#
# Break-tested, including what it does NOT cover:
#   plain mention on an ordinary line            -> still caught
#   the attribution line itself                  -> suppressed, as intended
#   attribution shape PLUS a payload, same line  -> NOT caught
# That last one is `apply_exclusion` operating on whole lines, which every
# exclusion in this file inherits; it is not specific to this one. Fixing it
# properly means matching on the matched text rather than the line, which
# changes the output format. Recorded here so the limit is known rather than
# discovered.
LICENSE_ATTRIBUTION='\[MIT\]\(LICENSE\), \(c\) 20[0-9][0-9] '

# Some repos name the employer on purpose: a marketplace written for colleagues
# says so in its README by design. Those opt out with a repo-root marker rather
# than carrying a permanent red light.
if [ ! -f ".pii-gauntlet-allow-employer-name" ]; then
  check "Employer name" '(^|[^A-Za-z0-9])(NBG|ΕΤΕ)([^A-Za-z0-9]|$)|Εθνική Τράπεζα|National Bank of Greece' "$PLACEHOLDER"
else
  echo "OK   [Employer name] (opted out via .pii-gauntlet-allow-employer-name)"
fi

check "Employer mail domain" '[A-Za-z0-9._%+-]+@nbg\.gr' "$PLACEHOLDER"
check "SharePoint tenant"    '[a-z0-9-]+\.sharepoint\.com' "$PLACEHOLDER"
# A bare UUID is not a finding: fixtures, generated filenames and message ids
# are full of them, and flagging all of them is how a check earns the right to
# be ignored. What matters is a GUID sitting where a TENANT id sits, so key on
# the surrounding context rather than on the shape alone.
check "Azure AD tenant id" \
  '(tenant[_-]?id|tenantId|\"tid\"|authority|login\.microsoftonline\.com/|realm)[^0-9a-f]{0,24}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  '00000000-0000-0000-0000-000000000000|11111111-2222-3333-4444-555555555555|00000000-|11111111-|22222222-|33333333-|44444444-|55555555-|66666666-|77777777-|88888888-|99999999-|aaaaaaaa-|bbbbbbbb-|cccccccc-|dddddddd-|eeeeeeee-|ffffffff-|/common|/organizations|/consumers'

# ---------------------------------------------------------------------------
# Greek personal-name SHAPE
# ---------------------------------------------------------------------------
#
# Two consecutive all-caps Greek words is how Greek corporate systems write a
# person: SURNAME FORENAME. This closes a class the private denylist
# structurally cannot, because a denylist only ever holds the names somebody
# remembered to add. It was found the hard way: a real colleague's full name
# sat in a tracked test file of a PUBLIC repo from its first commit, with the
# denylist loaded and the gauntlet printing PASS every single run.
#
# Greek capitals are enumerated ONE CODEPOINT AT A TIME as an alternation, not
# as the range [<Alpha>-<Omega>] and not as a bracket set. Both of those are
# resolved by the LOCALE: in a UTF-8 locale each letter is one collating
# element, and under C or POSIX the same expression decays into its individual
# BYTES. Measured with a bracket form of this rule over a fixture: 4 hits under
# en_US.UTF-8 and C.UTF-8, 5 under C and POSIX, because the length quantifier
# then counts bytes and a two-letter word (4 bytes) clears a three-CHARACTER
# minimum. The rule would mean something different on the runner than on the
# maintainer's laptop, which is the bug that already bit this project once: a
# multibyte range that resolved on BSD and not on GNU passed all through
# development, then reported nothing on the first ubuntu run. An alternation of
# literal characters has no collation to get wrong. Measured 3 hits on the same
# fixture under all four locales.
#
# The class is the 24 plain capitals plus the two dialytika forms, which Greek
# all-caps preserves. The seven tonos-bearing capitals are deliberately absent,
# because Greek all-caps drops the tonos. The cost is a miss on a name emitted
# with an accent left on, where the letter run breaks at that letter. Stated,
# not hidden.
GRK_CAP='(Α|Β|Γ|Δ|Ε|Ζ|Η|Θ|Ι|Κ|Λ|Μ|Ν|Ξ|Ο|Π|Ρ|Σ|Τ|Υ|Φ|Χ|Ψ|Ω|Ϊ|Ϋ)'

# Four characters minimum, on BOTH words. Measured across the seven public
# repositories that carry this script: 11 raw pairs of two consecutive all-caps
# Greek words exist in total. A three-character minimum leaves 6, all of them
# false; four leaves 3; five leaves the same 3 while starting to miss real
# four-letter Greek forenames. Four is the knee. It also kills the acronym
# class outright, since every Greek acronym in use across these repos is two or
# three letters, along with every Greek article, conjunction and preposition
# that would otherwise pair with the noun after it.
#
# Deliberately NOT required: that the pair be alone on its line or bounded by
# punctuation. Measured, every non-person pair in these trees is already
# exactly two words and bounded by quotes or backticks, so boundedness
# separates nothing, and requiring it would only lose three-part names.
GREEK_NAME_SHAPE="${GRK_CAP}{4,}[[:space:]]+${GRK_CAP}{4,}"

# No exclusion. Measured over this tree: zero occurrences of two consecutive
# all-caps Greek words, at any minimum length. If one appears, the check firing
# once is the check doing its job; classify it then, and add it here as an
# exact two-word VALUE only if it is genuinely not a person. Never as a single
# word and never as a path: a one-word exclusion hands anyone a suppression
# token, which is the defect the old "copyright" filter had.
check_shape "All-caps Greek personal name" "$GREEK_NAME_SHAPE" ''

# ---------------------------------------------------------------------------
# Name-based checks, loaded from a private denylist
# ---------------------------------------------------------------------------
#
# The literal terms used to live in this file. That made the guard the
# disclosure: this script is anonymously readable, and it enumerated colleague
# names, a family name, a personal mobile and address, personal emails,
# unreleased internal project names, the partner list and every private repo
# path, complete with comment headers explaining which was which.
#
# They now live outside every public repo. Nothing here reveals what is checked.

PII_DENYLIST="${PII_DENYLIST:-$HOME/.claude/private/pii-denylist.conf}"

if [ -r "$PII_DENYLIST" ]; then
  # Tab-delimited: the patterns are full of regex alternation pipes, so "|"
  # cannot be the field separator.
  loaded=0
  # The repo-local placeholder VALUE is ORed onto each entry's own exclude
  # column. The denylist is shared by several repos and cannot know about a
  # placeholder specific to this one, and editing it from here would change
  # every repo's gate at once.
  while IFS=$'\t' read -r label pattern exclude; do
    case "$label" in ''|\#*) continue ;; esac
    [ -z "$pattern" ] && continue
    if [ -n "$exclude" ]; then
      exclude="$exclude|$PLACEHOLDER_VALUE|$LICENSE_ATTRIBUTION"
    else
      exclude="$PLACEHOLDER_VALUE|$LICENSE_ATTRIBUTION"
    fi
    check "$label" "$pattern" "$exclude"
    loaded=$((loaded + 1))
  done < "$PII_DENYLIST"
  echo "     ($loaded name-based checks loaded from the private denylist)"
else
  # Absence is handled differently by mode, on purpose.
  #
  # In CI on a public repo the denylist legitimately does not exist and never
  # will, so failing here would just paint six repos red forever. Say plainly
  # that the name checks did not run, and let the generic ones stand.
  #
  # Locally the file should always be there. Its absence is a real
  # misconfiguration, and a guard that cannot evaluate its condition must
  # refuse rather than pass. That distinction is the whole point: the previous
  # version of this script reported OK on every check while, on macOS, scanning
  # exactly zero files.
  if [ "$MODE" = "ci" ]; then
    echo "SKIP [name-based checks]: no denylist at $PII_DENYLIST"
    echo "     Generic org-tell checks above still ran. Name, family, partner and"
    echo "     private-path checks did NOT. This is expected in public CI."
  else
    echo "FAIL [name-based checks]: no denylist at $PII_DENYLIST"
    echo "     Locally this file must exist. Without it the name, family, partner"
    echo "     and private-path checks are silently absent, which is exactly the"
    echo "     false green this rewrite removes."
    echo "     Fix: ensure ~/.claude/private -> claude-config/private is linked,"
    echo "     or set PII_DENYLIST to the file."
    FAIL=1
  fi
fi

if [ $FAIL -eq 0 ]; then
  if [ "$MODE" = "doctor" ] && [ $INFO -ne 0 ]; then
    echo "=== GAUNTLET PASS (with INFO on gitignored files — local-only, not in git) ==="
  else
    echo "=== GAUNTLET PASS ==="
  fi
  exit 0
else
  echo "=== GAUNTLET FAIL ==="
  if [ "$MODE" = "doctor" ]; then
    echo "Tracked PII detected. These files would ship publicly. Fix before committing."
  else
    echo "Fix the PII leaks above before any public push."
  fi
  exit 1
fi
