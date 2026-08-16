#!/usr/bin/env bash
#
# アプリを更新して公開する。
#   ./deploy.sh                 … メッセージ省略（「アプリを更新」でコミット）
#   ./deploy.sh "ホテルのメモを修正"
#
# やっていること：
#   1. GitHub 側の最新を取り込む（スマホから追加したお店の予定が入っている）
#   2. docs/ が変わっていれば sw.js のバージョンを自動で上げる（古いPDFが残らないように）
#   3. コミットして push
#
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-アプリを更新}"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "❌ origin が設定されていません。最初に1回だけ以下を実行してください："
  echo "   git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git"
  exit 1
fi

echo "▶ GitHub の最新を取り込みます…"
if ! git pull --rebase --autostash origin main; then
  cat <<'EOS'

⚠ 取り込みで競合しました。
   data/extras.json（お店の予定）が原因のことがほとんどです。
   スマホから入れた内容を正とするなら、次の2行を実行してください：

       git checkout --ours data/extras.json
       git add data/extras.json && git rebase --continue

   そのうえで ./deploy.sh をもう一度実行してください。
EOS
  exit 1
fi

# docs/ に変更があれば、オフラインキャッシュのバージョンを上げる
if ! git diff --quiet -- docs/ || [ -n "$(git ls-files --others --exclude-standard docs/)" ]; then
  python3 - <<'PY'
import re, pathlib
p = pathlib.Path('sw.js'); s = p.read_text(encoding='utf-8')
m = re.search(r"const VERSION = 'kt-v(\d+)';", s)
if m:
    n = int(m.group(1)) + 1
    p.write_text(s.replace(m.group(0), f"const VERSION = 'kt-v{n}';"), encoding='utf-8')
    print(f"▶ docs/ が変わったので sw.js を kt-v{n} に上げました")
PY
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "▶ ローカルの変更はありません。"
else
  git add -A
  git commit -q -m "$MSG"
  echo "▶ コミットしました：$MSG"
fi

echo "▶ push します…"
git push origin main

REPO_URL="$(git remote get-url origin | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')"
OWNER="${REPO_URL%%/*}"
NAME="${REPO_URL##*/}"
echo
echo "✅ 完了しました。1〜2分で反映されます。"
echo "   https://${OWNER}.github.io/${NAME}/"
