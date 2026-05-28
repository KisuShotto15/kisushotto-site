#!/usr/bin/env bash
# Builds a signed TWA APK for habits.kisushotto.com
# Installs all prerequisites automatically on first run (~10-15 min)
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$REPO_ROOT/habits-twa.keystore"
KEY_ALIAS="habits-key"
KEY_PASS="habits2024"
ANDROID_SDK="$HOME/.android-sdk"
GRADLE_VERSION="8.4"
GRADLE_HOME="$HOME/.local/gradle-${GRADLE_VERSION}"
GRADLE_BIN="$GRADLE_HOME/bin/gradle"
TWA_DIR="$REPO_ROOT/habits-twa"

# ── 1. Java JDK 17 (portable, no sudo) ────────────────────────────────────────
JDK_DIR="$HOME/.local/jdk17"
if [ ! -f "$JDK_DIR/bin/java" ]; then
  echo "[prereq] Downloading JDK 17 (~185MB)..."
  TMP=$(mktemp -d)
  wget -q --show-progress \
    "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_linux_hotspot_17.0.13_11.tar.gz" \
    -O "$TMP/jdk17.tar.gz"
  mkdir -p "$JDK_DIR"
  tar -xzf "$TMP/jdk17.tar.gz" -C "$JDK_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
echo "[prereq] Java: $(java -version 2>&1 | head -1)"

# ── 2. Android SDK ─────────────────────────────────────────────────────────────
SDKMANAGER="$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager"
if [ ! -f "$SDKMANAGER" ]; then
  echo "[prereq] Downloading Android cmdline-tools..."
  TMP=$(mktemp -d)
  wget -q --show-progress \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
    -O "$TMP/cmdline-tools.zip"
  mkdir -p "$ANDROID_SDK/cmdline-tools"
  unzip -q "$TMP/cmdline-tools.zip" -d "$TMP"
  mv "$TMP/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
  rm -rf "$TMP"
fi
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export PATH="$ANDROID_SDK/cmdline-tools/latest/bin:$ANDROID_SDK/platform-tools:$PATH"

if [ ! -d "$ANDROID_SDK/platforms/android-34" ]; then
  echo "[prereq] Installing Android SDK packages..."
  yes | sdkmanager --licenses > /dev/null 2>&1 || true
  sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
fi

# ── 3. Gradle 8.4 ─────────────────────────────────────────────────────────────
if [ ! -f "$GRADLE_BIN" ]; then
  echo "[prereq] Downloading Gradle ${GRADLE_VERSION} (~130MB)..."
  TMP=$(mktemp -d)
  wget -q --show-progress \
    "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    -O "$TMP/gradle.zip"
  mkdir -p "$HOME/.local"
  unzip -q "$TMP/gradle.zip" -d "$HOME/.local"
  rm -rf "$TMP"
fi
export GRADLE_USER_HOME="$HOME/.gradle"
echo "[prereq] Gradle: $($GRADLE_BIN --version 2>/dev/null | grep 'Gradle ' | head -1)"

# ── 4. Signing keystore ────────────────────────────────────────────────────────
if [ ! -f "$KEYSTORE" ]; then
  echo "[keystore] Generating signing keystore..."
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "$KEY_PASS" -keypass "$KEY_PASS" \
    -dname "CN=KisuShotto, O=KisuShotto, C=US"
  echo "[keystore] Created: $KEYSTORE"
fi

# ── 5. Generate Android project files ─────────────────────────────────────────
echo "[project] Generating Android project files..."
mkdir -p "$TWA_DIR/app/src/main/res/values"
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  mkdir -p "$TWA_DIR/app/src/main/res/mipmap-$d"
done
mkdir -p "$TWA_DIR/app/src/main/res/mipmap-anydpi-v26"
mkdir -p "$TWA_DIR/app/src/main/res/drawable"

cat > "$TWA_DIR/settings.gradle" << 'SEOF'
rootProject.name = "KsHabits"
include ':app'
SEOF

cat > "$TWA_DIR/build.gradle" << 'BEOF'
buildscript {
    repositories { google(); mavenCentral() }
    dependencies { classpath 'com.android.tools.build:gradle:8.1.4' }
}
allprojects {
    repositories { google(); mavenCentral() }
}
BEOF

cat > "$TWA_DIR/app/build.gradle" << ABEOF
plugins { id 'com.android.application' }
android {
    namespace 'com.kisushotto.habits'
    compileSdk 34
    defaultConfig {
        applicationId 'com.kisushotto.habits'
        minSdk 21
        targetSdk 34
        versionCode 2
        versionName '1.1.0'
    }
    signingConfigs {
        release {
            storeFile file('../../habits-twa.keystore')
            storePassword '$KEY_PASS'
            keyAlias '$KEY_ALIAS'
            keyPassword '$KEY_PASS'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            signingConfig signingConfigs.release
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}
dependencies {
    implementation 'com.google.androidbrowserhelper:androidbrowserhelper:2.5.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
}
ABEOF

cat > "$TWA_DIR/app/src/main/AndroidManifest.xml" << 'MEOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">
        <activity
            android:name="com.google.androidbrowserhelper.trusted.LauncherActivity"
            android:exported="true">
            <meta-data
                android:name="android.support.customtabs.trusted.DEFAULT_URL"
                android:value="https://habits.kisushotto.com/" />
            <meta-data
                android:name="android.support.customtabs.trusted.STATUS_BAR_COLOR"
                android:resource="@color/colorPrimary" />
            <meta-data
                android:name="android.support.customtabs.trusted.NAVIGATION_BAR_COLOR"
                android:resource="@color/backgroundColor" />
            <meta-data
                android:name="android.support.customtabs.trusted.NAVIGATION_BAR_DIVIDER_COLOR"
                android:resource="@color/backgroundColor" />
            <meta-data
                android:name="android.support.customtabs.trusted.SPLASH_SCREEN_BACKGROUND_COLOR"
                android:resource="@color/backgroundColor" />
            <meta-data
                android:name="android.support.customtabs.trusted.SPLASH_SCREEN_FADE_OUT_DURATION"
                android:value="300" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW"/>
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE"/>
                <data android:scheme="https" android:host="habits.kisushotto.com" />
            </intent-filter>
        </activity>
        <service
            android:name="com.google.androidbrowserhelper.trusted.DelegationService"
            android:exported="true"
            android:enabled="true">
            <intent-filter>
                <action android:name="android.support.customtabs.trusted.TRUSTED_WEB_ACTIVITY_SERVICE"/>
                <category android:name="android.intent.category.DEFAULT"/>
            </intent-filter>
        </service>
    </application>
</manifest>
MEOF

cat > "$TWA_DIR/app/src/main/res/values/strings.xml" << 'SXEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Habits</string>
</resources>
SXEOF

cat > "$TWA_DIR/app/src/main/res/values/styles.xml" << 'STEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="android:windowBackground">@color/backgroundColor</item>
        <item name="android:statusBarColor">@color/backgroundColor</item>
        <item name="android:navigationBarColor">@color/backgroundColor</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>
</resources>
STEOF

cat > "$TWA_DIR/app/src/main/res/values/colors.xml" << 'CEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#0d0d0f</color>
    <color name="backgroundColor">#0d0d0f</color>
</resources>
CEOF

cat > "$TWA_DIR/local.properties" << LPEOF
sdk.dir=$ANDROID_SDK
LPEOF

cat > "$TWA_DIR/gradle.properties" << 'GPEOF'
android.useAndroidX=true
android.enableJetifier=true
org.gradle.jvmargs=-Xmx2g
GPEOF

# ── 6. Launcher icons via sharp ────────────────────────────────────────────────
echo "[icons] Generating launcher icons..."
cd "$REPO_ROOT"
node -e "
const sharp = require('sharp');
const src = 'public/images/habits-icon.svg';
const bg = { r: 13, g: 13, b: 15, alpha: 1 }; // #0d0d0f

async function makeIcon(dst, canvas) {
  const iconSize = Math.round(canvas * 0.82);
  const iconBuf = await sharp(src).resize(iconSize, iconSize).png().toBuffer();
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: bg } })
    .composite([{ input: iconBuf, gravity: 'center' }])
    .png()
    .toFile(dst);
}

async function makeForeground(dst, canvas) {
  const iconSize = Math.round(canvas * 0.65);
  const iconBuf = await sharp(src).resize(iconSize, iconSize).png().toBuffer();
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
    .composite([{ input: iconBuf, gravity: 'center' }])
    .png()
    .toFile(dst);
}

Promise.all([
  makeIcon('habits-twa/app/src/main/res/mipmap-mdpi/ic_launcher.png', 48),
  makeIcon('habits-twa/app/src/main/res/mipmap-hdpi/ic_launcher.png', 72),
  makeIcon('habits-twa/app/src/main/res/mipmap-xhdpi/ic_launcher.png', 96),
  makeIcon('habits-twa/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', 144),
  makeIcon('habits-twa/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192),
  makeForeground('habits-twa/app/src/main/res/drawable/ic_launcher_foreground.png', 432),
]).then(() => console.log('Icons generated OK')).catch(e => { console.error(e); process.exit(1); });
"

cat > "$TWA_DIR/app/src/main/res/drawable/ic_launcher_background.xml" << 'DIBEOF'
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="#0d0d0f"/>
</shape>
DIBEOF

cat > "$TWA_DIR/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml" << 'AIEOF'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
AIEOF

# ── 7. Build APK ───────────────────────────────────────────────────────────────
echo "[build] Building APK..."
cd "$TWA_DIR"
"$GRADLE_BIN" assembleRelease \
  --project-dir "$TWA_DIR" \
  --no-daemon

APK=$(find "$TWA_DIR/app/build/outputs/apk/release" -name "*.apk" 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "[error] APK not found under app/build/outputs/apk/release/"
  exit 1
fi

cp "$APK" "$REPO_ROOT/KsHabits.apk"
echo "[build] APK ready: $REPO_ROOT/KsHabits.apk  ($(du -sh "$REPO_ROOT/KsHabits.apk" | cut -f1))"

# ── 8. Extract fingerprint & write assetlinks.json ────────────────────────────
echo "[assetlinks] Extracting SHA256 fingerprint..."
FINGERPRINT=$(keytool -list -v \
  -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
  -storepass "$KEY_PASS" 2>/dev/null \
  | grep "SHA256:" | head -1 | sed 's/.*SHA256: //')

if [ -z "$FINGERPRINT" ]; then
  echo "[error] Could not extract fingerprint from keystore."
  exit 1
fi
echo "[assetlinks] Fingerprint: $FINGERPRINT"

mkdir -p "$REPO_ROOT/public/.well-known"
cat > "$REPO_ROOT/public/.well-known/habits-assetlinks.json" << ALEOF
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.kisushotto.habits",
    "sha256_cert_fingerprints": ["$FINGERPRINT"]
  }
}]
ALEOF
echo "[assetlinks] Written: public/.well-known/habits-assetlinks.json"

# ── 9. Rebuild habits-pwa with assetlinks ─────────────────────────────────────
echo "[pwa] Rebuilding habits-pwa with assetlinks..."
cd "$REPO_ROOT"
bash scripts/build-habits-pwa.sh

echo ""
echo "=============================="
echo " TWA APK build complete!"
echo "=============================="
echo " APK:  $REPO_ROOT/KsHabits.apk"
echo " SHA:  $FINGERPRINT"
echo ""
echo "Next steps:"
echo "  1. git add habits-twa/ habits-pwa/ public/.well-known/ .gitignore scripts/ KsHabits.apk"
echo "  2. git commit && git push   <- deploys assetlinks.json to habits.kisushotto.com"
echo "  3. Transfer KsHabits.apk to phone and install"
echo "  4. Or: adb install \"$REPO_ROOT/KsHabits.apk\""
echo ""
echo "Note: The app will show a small address bar until assetlinks.json is deployed."
