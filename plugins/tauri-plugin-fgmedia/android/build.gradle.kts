plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.sylm54.train.fgmedia"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    // MediaSessionCompat + PlaybackStateCompat — what Chromium-WebView keys
    // off to treat an app as a media player and keep audio alive.
    implementation("androidx.media:media:1.7.0")
    implementation(project(":tauri-android"))
}
