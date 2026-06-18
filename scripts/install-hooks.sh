#!/usr/bin/env bash
# Run once after cloning: npm run prepare
# Sets up git hooks that run tests before every push.
set -e

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-push" <<'HOOK'
#!/usr/bin/env bash
echo "🧪 Running tests before push..."
npm test --silent
if [ $? -ne 0 ]; then
  echo "❌ Tests failed — push blocked. Fix tests first."
  exit 1
fi
echo "✅ All tests passed."
HOOK

chmod +x "$HOOK_DIR/pre-push"
echo "✅ pre-push hook installed — tests will run automatically before every git push."
