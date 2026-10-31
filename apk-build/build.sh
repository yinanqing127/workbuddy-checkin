#!/usr/bin/env bash
# 用本机免安装的 Android 工具链把 WorkBuddy 签到做成真正的 .apk
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
TC="$ROOT/toolchain"
JDK_ZIP="$TC/jdk.zip"; BT_ZIP="$TC/build-tools.zip"; PL_ZIP="$TC/platform.zip"

extract() {
  local z="$1" t="$2"
  if [ -d "$t" ]; then echo "[*] $t 已存在，跳过解压"; return; fi
  echo "[*] 解压 $z -> $t"
  python - "$z" "$t" <<'PY'
import zipfile, sys, os, shutil
z, t = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(z) as zf:
    names = zf.namelist()
    prefix = names[0].split('/')[0]
    inner = prefix + '/'
    tmp = t + '.extract'
    if os.path.exists(tmp): shutil.rmtree(tmp)
    zf.extractall(tmp)
    src = os.path.join(tmp, inner.rstrip('/'))
    os.makedirs(os.path.dirname(os.path.abspath(t)), exist_ok=True)
    shutil.move(src, t)
    shutil.rmtree(tmp)
print('  extracted ->', t)
PY
}
extract "$BT_ZIP" "$TC/build-tools"
extract "$PL_ZIP" "$TC/platform"
extract "$JDK_ZIP" "$TC/jdk"

JAVA_BIN="$TC/jdk/bin"
JAVA="$JAVA_BIN/java"
BT="$TC/build-tools"
PLATFORM="$TC/platform"
AAPT2="$BT/aapt2.exe"
ZIPALIGN="$BT/zipalign.exe"
ANDROID_JAR="$PLATFORM/android.jar"
D8_JAR="$BT/lib/d8.jar"
APKSIGNER_JAR="$BT/lib/apksigner.jar"
KEY="$ROOT/upload-key.jks"
KS_PASS="YOUR_KS_PASS"; ALIAS="wbcheckin"

echo "[*] 校验关键工具"
for f in "$AAPT2" "$ZIPALIGN" "$ANDROID_JAR" "$D8_JAR" "$APKSIGNER_JAR" "$JAVA_BIN/javac" "$JAVA_BIN/keytool"; do
  [ -f "$f" ] || { echo "[FATAL] 缺少: $f"; exit 1; }
done

echo "[*] 生成图标(若缺失)"
if [ ! -f "$ROOT/res/mipmap-hdpi/ic_launcher.png" ]; then node "$ROOT/gen_icons.js"; fi

rm -rf "$ROOT/obj" "$ROOT/obj.jar" "$ROOT/dexout" "$ROOT/res.zip" "$ROOT/app-unsigned.apk" "$ROOT/app-aligned.apk"
mkdir -p "$ROOT/obj" "$ROOT/dexout"

echo "[*] 编译 MainActivity.java"
"$JAVA_BIN/javac" -encoding UTF-8 -cp "$ANDROID_JAR" -d "$ROOT/obj" "$ROOT/src/com/workbuddy/checkin/MainActivity.java"

echo "[*] 打包 class 为 jar"
"$JAVA_BIN/jar" cf "$ROOT/obj.jar" -C "$ROOT/obj" .

echo "[*] 生成 classes.dex (d8 -> 输出目录)"
"$JAVA" -cp "$D8_JAR" com.android.tools.r8.D8 --release --lib "$ANDROID_JAR" --output "$ROOT/dexout" "$ROOT/obj.jar"

echo "[*] 编译资源 (aapt2 compile)"
"$AAPT2" compile -o "$ROOT/res.zip" --dir "$ROOT/res"

echo "[*] 链接 APK (aapt2 link)"
"$AAPT2" link --auto-add-overlay -o "$ROOT/app-unsigned.apk" -I "$ANDROID_JAR" \
  --manifest "$ROOT/AndroidManifest.xml" -R "$ROOT/res.zip" \
  --package-id 0x7f --min-sdk-version 21 --target-sdk-version 34 --no-version-vectors

echo "[*] 注入 classes.dex"
( cd "$ROOT/dexout" && "$JAVA_BIN/jar" uf "$ROOT/app-unsigned.apk" classes.dex )

echo "[*] zipalign 对齐"
"$ZIPALIGN" -p 4 "$ROOT/app-unsigned.apk" "$ROOT/app-aligned.apk"

echo "[*] 生成/复用签名密钥"
if [ ! -f "$KEY" ]; then
  "$JAVA_BIN/keytool" -genkeypair -v -keystore "$KEY" -keyalg RSA -keysize 2048 \
    -validity 10000 -alias "$ALIAS" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=WorkBuddy,OU=Checkin,O=WorkBuddy,C=CN"
fi

echo "[*] apksigner 签名"
"$JAVA" -cp "$APKSIGNER_JAR" com.android.apksigner.ApkSignerTool sign --ks "$KEY" --ks-key-alias "$ALIAS" \
  --ks-pass pass:"$KS_PASS" --key-pass pass:"$KS_PASS" "$ROOT/app-aligned.apk"

FINAL="$ROOT/WorkBuddyCheckin-1.0.0.apk"
cp "$ROOT/app-aligned.apk" "$FINAL"
echo ""
echo "[DONE] 最终 APK: $FINAL"
echo "       大小: $(stat -c%s "$FINAL") bytes"
"$JAVA" -cp "$APKSIGNER_JAR" com.android.apksigner.ApkSignerTool verify --print-certs "$FINAL" 2>&1 | head -8
