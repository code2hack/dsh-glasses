plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.code2hack.glasses"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.code2hack.glasses"
    minSdk = 24
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0-g0"
  }

  buildFeatures {
    buildConfig = true
  }

  buildTypes {
    debug {
      isDebuggable = true
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

// G0 deliberately uses only Android framework APIs. Keeping the shell free of
// AndroidX/coroutines shortens cold builds on u4090 and reduces Rokid footprint.
