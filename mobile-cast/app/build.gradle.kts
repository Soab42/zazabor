// Zazabor Link (was Zazabor Cast): mirrors the phone's screen and sound to Zazabor on a PC
// (docs/plans/cast-receiver.md) and links the phone to Zazabor's Phone section (docs/plans/phone-link.md).
// Plain Android Views and platform APIs only, so the app stays small. AGP 9 compiles the Kotlin.
plugins {
    id("com.android.application")
}

android {
    namespace = "dev.soab.zazabor.cast"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.soab.zazabor.cast"
        minSdk = 29
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // The JVM tests run Link/ZlnkCrypto off-device; android.jar only stubs org.json there.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
