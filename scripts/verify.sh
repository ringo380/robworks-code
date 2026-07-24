#!/bin/sh
# The whole gate. Runs offline, needs nothing installed but node.
#
# There is no CI on this repo on purpose: every check it would run is here, and
# a pre-push hook runs this with no wait for a remote runner. Add checks here,
# never in a workflow file. GitHub Pages publishing is separate - it is the
# built-in legacy publisher, not a workflow, so it is unaffected by any of this.

cd "$(dirname "$0")/.." || exit 1
FAILED=""

note_failure() {
    printf 'FAIL: %s (exit %s)\n' "$1" "$2"
    FAILED="$FAILED$1; "
}

echo "=== generated pages are current ==="
# The generator is the only thing allowed to write the regions between the
# BEGIN:/END: sentinels. Regenerating and requiring no diff catches the failure
# that actually happens: marketplace.json gains a plugin, the site is not
# rebuilt, and the deployed page keeps a stale count and a stale licence claim
# until somebody notices. build-site.js also asserts its own copy guards, so a
# non-zero exit here is a real content problem, not just drift.
node scripts/build-site.js >/dev/null 2>&1
rc=$?
if [ $rc -ne 0 ]; then
    echo "ERROR: scripts/build-site.js failed. Re-run it directly to see why:"
    echo "  node scripts/build-site.js"
    note_failure "build-site.js" $rc
elif ! git diff --quiet -- docs/; then
    echo "ERROR: docs/ is out of date - scripts/build-site.js changed it."
    echo "Commit the regenerated files."
    git --no-pager diff --stat -- docs/
    note_failure "generated pages are stale" 1
else
    echo "ok: docs/ matches the generator"
fi

echo ""
echo "=== inline page scripts parse ==="
# The plugin cards are rendered client-side from marketplace.json, so a syntax
# error in that inline script breaks the grid on a page that still looks fine
# in a diff. JSON-LD blocks are data, not JavaScript, and are skipped.
node -e "
const fs = require('fs');
const files = ['docs/index.html', 'docs/plugins/index.html'].filter(f => fs.existsSync(f));
let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  for (const block of html.match(/<script([^>]*)>([\s\S]*?)<\/script>/g) || []) {
    const attrs = (block.match(/<script([^>]*)>/) || [])[1] || '';
    if (/ld\+json|src=/.test(attrs)) continue;
    try { new Function(block.replace(/<\/?script[^>]*>/g, '')); }
    catch (e) { bad++; console.error(f + ': ' + e.message); }
  }
}
if (bad) process.exit(1);
console.log('ok: inline scripts parse');
"
[ $? -eq 0 ] || note_failure "inline page scripts" $?

echo ""
if [ -n "$FAILED" ]; then
    echo "VERIFY FAILED: $FAILED"
    exit 1
fi
echo "VERIFY PASSED"
