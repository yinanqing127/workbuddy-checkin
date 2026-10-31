#!/usr/bin/env bash
# 分块下载（规避代理对大文件的截断）：每块 8MB，校验长度，失败重试
# 关键修复：分块序号零填充，保证 cat 拼接顺序正确
set -u
url="$1"; out="$2"; tmp="$out.tmp"; cs=8388608
mkdir -p "$(dirname "$out")"
echo "[*] HEAD $url"
total=$(curl -sI -L "$url" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{v=$2} END{print v}')
if [ -z "$total" ]; then
  cr=$(curl -sI -r 0-0 -L "$url" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-range"{v=$2} END{print v}')
  total=$(echo "$cr" | sed -E 's#.*/([0-9]+).*#\1#')
fi
echo "[*] total bytes = $total"
pos=0; idx=0
rm -f "$tmp".part.*
while [ "$pos" -lt "$total" ]; do
  end=$(( pos + cs - 1 ))
  [ "$end" -ge "$total" ] && end=$(( total - 1 ))
  want=$(( end - pos + 1 ))
  part=$(printf '%s.part.%04d' "$tmp" "$idx")
  ok=0
  for try in 1 2 3 4 5; do
    curl -s -r ${pos}-${end} -L "$url" -o "$part"
    got=$(stat -c%s "$part" 2>/dev/null || echo 0)
    if [ "$got" -eq "$want" ]; then ok=1; break; fi
    echo "  ! chunk $idx try $try got $got want $want, retry"
    sleep 1
  done
  if [ "$ok" -ne 1 ]; then echo "[FATAL] chunk $idx failed after retries"; exit 1; fi
  pos=$(( end + 1 )); idx=$(( idx + 1 ))
  printf "\r  -> %.1f%%" "$(echo "scale=1; $pos*100/$total" | bc 2>/dev/null || echo 0)"
done
echo ""
cat $(ls "$tmp".part.* | sort) > "$out"
rm -f "$tmp".part.*
echo "[OK] $out ($(stat -c%s "$out") bytes)"
