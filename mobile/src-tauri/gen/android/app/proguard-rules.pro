# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The QR scanner (tauri-plugin-barcode-scanner) runs on CameraX and ML Kit, which create some of
# their classes by reflection. R8 stripped them in the first release build and Scan crashed with a
# NullPointerException inside com.google.android.gms.internal.mlkit_vision_common.
-keep class app.tauri.barcodescanner.** { *; }
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_** { *; }
-keep class com.google.android.odml.** { *; }
-keep class androidx.camera.** { *; }
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.internal.mlkit_vision_**

# Readable stack traces from release builds (with build/outputs/mapping/*/mapping.txt).
-keepattributes SourceFile,LineNumberTable
