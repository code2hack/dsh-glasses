# glasses-android (G0)

Debug shell for the Rokid glasses: one Activity, one dedicated WebView, a
narrow origin-restricted native bridge, an input tracer, and WebView-owned
bootstrap/SSE projection.

## Build (u4090 only; SDK at /opt/android-sdk)

    cd apps/glasses-android
    gradle wrapper        # once, if the wrapper jar is missing
    ./gradlew assembleDebug
    /opt/android-sdk/platform-tools/adb -s 1906092617103125 install -r -t app/build/outputs/apk/debug/app-debug.apk

## G0 doesn't include

draft mutation, Send/Steer/Interrupt, cursor, wheel, Photo/Voice/Morse,
multiple tabs, pairing, Funnel, release build.

## Credentials

The dev bearer token + session id are provisioned at runtime into app-private
storage (bridge.configure) and are never committed.
