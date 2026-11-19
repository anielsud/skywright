package com.anielsud.skywright;

import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Skywright's Android shell. The WebView runs the live site (server.url in capacitor.config.json), whose
 * service worker keeps it playable offline. This activity adds what a browser tab can't do on its own:
 * - immersive fullscreen (no status or navigation bar; swipe from an edge to peek at them)
 * - the screen stays on while the app is in front
 * - the system back button acts like Escape in the game (window.skywrightBack in src/main.js)
 * - an offline fallback: if the live site can't load at all (first launch with no network, or its
 *   offline cache was cleared), show the copy of the site bundled in the APK (native/www).
 */
public class MainActivity extends BridgeActivity {

    /** The bundled copy is served from this origin (WebViewAssetLoader's reserved domain), from assets/public. */
    static final String FALLBACK_HOST = "appassets.androidplatform.net";
    static final String FALLBACK_URL = "https://" + FALLBACK_HOST + "/index.html";

    private boolean showingFallback = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        hideSystemBars();

        WebView webView = bridge.getWebView();
        WebSettings ws = webView.getSettings();
        ws.setMediaPlaybackRequiresUserGesture(false); // Capacitor sets this too; music and sounds may start without a tap
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        installOfflineFallback();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // The game decides what back means (close a dialog, pause/resume a flight, deselect in the hangar).
                // Older builds without the hook get an Escape key press, which pauses a flight.
                bridge.getWebView().evaluateJavascript(
                    "(function(){if(window.skywrightBack){window.skywrightBack();return;}" +
                    "var o={key:'Escape',code:'Escape',keyCode:27,bubbles:true};" +
                    "window.dispatchEvent(new KeyboardEvent('keydown',o));window.dispatchEvent(new KeyboardEvent('keyup',o));})()",
                    null
                );
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars(); // bars come back after dialogs, the keyboard or the app switcher
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void installOfflineFallback() {
        final WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .setDomain(FALLBACK_HOST)
            .addPathHandler("/", (path) -> assets.handle("public/" + path))
            .build();

        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (FALLBACK_HOST.equals(request.getUrl().getHost())) return loader.shouldInterceptRequest(request.getUrl());
                    return super.shouldInterceptRequest(view, request);
                }

                // Not calling super for errors: Capacitor's own errorPath handling (used on iOS) can't serve a
                // whole site on Android while server.url is set, so the bundled copy is served from FALLBACK_HOST.
                // (Super would only also notify WebViewListeners, and nothing in this app listens for errors.)
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) showFallback(view, request.getUrl());
                }

                @Override
                public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                    // a server error from Pages for the page itself: use the bundled copy
                    if (request.isForMainFrame() && response.getStatusCode() >= 500) showFallback(view, request.getUrl());
                }
            }
        );
    }

    private void showFallback(WebView view, Uri failed) {
        if (showingFallback || FALLBACK_HOST.equals(failed.getHost())) return;
        showingFallback = true;
        view.post(() -> view.loadUrl(FALLBACK_URL));
    }
}
