#!/usr/bin/env bash
# Android-only changes, applied after "npx cap add android" creates the project.
set -euo pipefail
cd "$(dirname "$0")"
M=android/app/src/main/AndroidManifest.xml

# app icons
cp -r res/. android/app/src/main/res/

# portrait only, and mark the app as a game (Samsung Game Launcher and Android's game settings read this)
sed -i 's/android:name=".MainActivity"/android:name=".MainActivity"\n            android:screenOrientation="portrait"/' "$M"
sed -i 's/<application/<application\n        android:appCategory="game"\n        android:isGame="true"/' "$M"

# vibration (the Haptics plugin also asks for this; listed here so plain vibration works too)
grep -q 'android.permission.VIBRATE' "$M" || sed -i 's#</manifest>#    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>#' "$M"

# fullscreen
cp native/MainActivity.java android/app/src/main/java/io/github/ryeggouti/storkflight/MainActivity.java

# version number goes up with every build, so a new APK installs over the old one
RUN="${RUN_NUMBER:-1}"
sed -i -E "s/versionCode [0-9]+/versionCode ${RUN}0/; s/versionName \"[^\"]*\"/versionName \"1.${RUN}\"/" android/app/build.gradle

grep -n "screenOrientation\|appCategory\|isGame\|VIBRATE" "$M"
grep -n "versionCode\|versionName" android/app/build.gradle
