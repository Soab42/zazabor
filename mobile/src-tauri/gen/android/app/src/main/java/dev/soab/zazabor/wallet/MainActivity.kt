package dev.soab.zazabor.wallet

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    Updater.maybeCheck(this, "wallet")
  }

  // The drawer's Check for Updates (src/mobile/main.ts) calls window.ZazaborUpdates.check().
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(UpdatesBridge(), "ZazaborUpdates")
    webView.addJavascriptInterface(SystemBridge(), "ZazaborSystem")
  }

  // The page draws under the system bars (edge to edge). The WebView reports the status bar as a
  // safe area but not the gesture or button bar, so src/mobile/main.ts asks for it here.
  private inner class SystemBridge {
    @JavascriptInterface
    fun bottomInset(): Float {
      val insets = ViewCompat.getRootWindowInsets(window.decorView) ?: return 0f
      return insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom / resources.displayMetrics.density
    }
  }

  private inner class UpdatesBridge {
    @JavascriptInterface
    fun check() = runOnUiThread { Updater.check(this@MainActivity, "wallet", manual = true) }

    @JavascriptInterface
    fun version(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
  }
}
