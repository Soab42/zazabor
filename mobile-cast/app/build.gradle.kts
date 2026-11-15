// Zazabor Link (was Zazabor Cast): mirrors the phone's screen and sound to Zazabor on a PC
// (docs/plans/cast-receiver.md) and links the phone to Zazabor's Phone section (docs/plans/phone-link.md).
// Plain Android Views and platform APIs only, so the app stays small. AGP 9 compiles the Kotlin.
import java.util.Properties

plugins {
    id("com.android.application")
}

// Release builds are signed with the key in ~/.config/zazabor-release (never in the repository);
// ZAZABOR_ANDROID_SIGNING names another properties file. Without one, release builds are unsigned.
val releaseSigning = Properties().apply {
    val path = System.getenv("ZAZABOR_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.config/zazabor-release/android-signing.properties"
    val propFile = file(path)
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "dev.soab.zazabor.cast"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.soab.zazabor.cast"
        minSdk = 29
        targetSdk = 35
        versionCode = 4
        versionName = "0.3.1"
    }

    signingConfigs {
        if (releaseSigning.containsKey("storeFile")) {
            create("release") {
                storeFile = file(releaseSigning.getProperty("storeFile"))
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfigs.findByName("release")?.let { signingConfig = it }
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
