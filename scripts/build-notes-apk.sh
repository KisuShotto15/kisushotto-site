#!/usr/bin/env bash
# Builds a signed TWA APK for notes.kisushotto.com
# Installs all prerequisites automatically on first run (~10-15 min)
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$REPO_ROOT/notes-twa.keystore"
KEY_ALIAS="notes-key"
KEY_PASS="notes2024"
ANDROID_SDK="$HOME/.android-sdk"
GRADLE_VERSION="8.4"
GRADLE_HOME="$HOME/.local/gradle-${GRADLE_VERSION}"
GRADLE_BIN="$GRADLE_HOME/bin/gradle"
TWA_DIR="$REPO_ROOT/notes-twa"

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

cat > "$TWA_DIR/settings.gradle" << 'SEOF'
rootProject.name = "KsNotes"
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

# app/build.gradle — uses shell vars for signing credentials
cat > "$TWA_DIR/app/build.gradle" << ABEOF
plugins { id 'com.android.application' }
android {
    namespace 'com.kisushotto.notes'
    compileSdk 34
    defaultConfig {
        applicationId 'com.kisushotto.notes'
        minSdk 21
        targetSdk 34
        versionCode 1
        versionName '1.0.0'
    }
    signingConfigs {
        release {
            storeFile file('../../notes-twa.keystore')
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
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.Light.NoActionBar">
        <activity
            android:name="com.google.androidbrowserhelper.trusted.LauncherActivity"
            android:exported="true">
            <meta-data
                android:name="android.support.customtabs.trusted.DEFAULT_URL"
                android:value="https://notes.kisushotto.com/" />
            <meta-data
                android:name="android.support.customtabs.trusted.STATUS_BAR_COLOR"
                android:resource="@color/colorPrimary" />
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
                <data android:scheme="https" android:host="notes.kisushotto.com" />
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
    <string name="app_name">Notes</string>
</resources>
SXEOF

cat > "$TWA_DIR/app/src/main/res/values/colors.xml" << 'CEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#111114</color>
    <color name="backgroundColor">#111114</color>
</resources>
CEOF

# local.properties — tells AGP where the Android SDK is
cat > "$TWA_DIR/local.properties" << LPEOF
sdk.dir=$ANDROID_SDK
LPEOF

# gradle.properties — required by androidbrowserhelper (uses AndroidX)
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
const src = 'public/images/notes-icon.svg';
const sizes = {
  'notes-twa/app/src/main/res/mipmap-mdpi/ic_launcher.png': 48,
  'notes-twa/app/src/main/res/mipmap-hdpi/ic_launcher.png': 72,
  'notes-twa/app/src/main/res/mipmap-xhdpi/ic_launcher.png': 96,
  'notes-twa/app/src/main/res/mipmap-xxhdpi/ic_launcher.png': 144,
  'notes-twa/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png': 192,
};
Promise.all(Object.entries(sizes).map(([dst, s]) =>
  sharp(src).resize(s, s).png().toFile(dst)
)).then(() => console.log('Icons generated OK')).catch(e => { console.error(e); process.exit(1); });
"

# ── 7. Build APK ───────────────────────────────────────────────────────────────
echo "[build] Building APK (first build downloads ~150MB of dependencies)..."
cd "$TWA_DIR"
"$GRADLE_BIN" assembleRelease \
  --project-dir "$TWA_DIR" \
  --no-daemon

APK=$(find "$TWA_DIR/app/build/outputs/apk/release" -name "*.apk" 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "[error] APK not found under app/build/outputs/apk/release/"
  find "$TWA_DIR" -name "*.apk" 2>/dev/null || true
  exit 1
fi

cp "$APK" "$REPO_ROOT/KsNotes.apk"
echo "[build] APK ready: $REPO_ROOT/KsNotes.apk  ($(du -sh "$REPO_ROOT/KsNotes.apk" | cut -f1))"

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
cat > "$REPO_ROOT/public/.well-known/assetlinks.json" << ALEOF
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.kisushotto.notes",
    "sha256_cert_fingerprints": ["$FINGERPRINT"]
  }
}]
ALEOF
echo "[assetlinks] Written: public/.well-known/assetlinks.json"

# ── 9. Rebuild notes-pwa with assetlinks ──────────────────────────────────────
echo "[pwa] Rebuilding notes-pwa with assetlinks..."
cd "$REPO_ROOT"
bash scripts/build-notes-pwa.sh

echo ""
echo "=============================="
echo " TWA APK build complete!"
echo "=============================="
echo " APK:  $REPO_ROOT/KsNotes.apk"
echo " SHA:  $FINGERPRINT"
echo ""
echo "Next steps:"
echo "  1. git add notes-twa/ notes-pwa/ public/.well-known/ .gitignore scripts/ KsNotes.apk"
echo "  2. git commit && git push   <- deploys assetlinks.json to notes.kisushotto.com"
echo "  3. Transfer KsNotes.apk to phone and install (Settings -> Install unknown apps)"
echo "  4. Open app -> should show notes.kisushotto.com without browser chrome"
echo ""
echo "Note: The app will show a small address bar until assetlinks.json is deployed."
