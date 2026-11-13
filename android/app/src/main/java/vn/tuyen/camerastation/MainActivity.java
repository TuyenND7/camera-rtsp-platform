package vn.tuyen.camerastation;

import android.annotation.SuppressLint;
import android.Manifest;
import android.content.pm.PackageManager;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.net.URI;
import java.net.URISyntaxException;

public final class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://camera.local:8081/live";
    private static final String ACTION_SERVER = "vn.tuyen.camerastation.SERVER";
    private static final String ACTION_RELOAD = "vn.tuyen.camerastation.RELOAD";
    private static final int INK = Color.rgb(31, 59, 96);
    private FrameLayout root;
    private LinearLayout content;
    private WebView webView;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private TextView errorMessage;
    private String serverUrl;
    private boolean pageFailed;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private static final int MIC_PERMISSION = 41;
    private PermissionRequest microphoneRequest;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        serverUrl = getPreferences(MODE_PRIVATE).getString("server_url", DEFAULT_URL);
        createViews();
        enterImmersiveMode();
        configureWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::navigateBack);
        }
        if (state == null || webView.restoreState(state) == null) webView.loadUrl(serverUrl);
        if (ACTION_SERVER.equals(getIntent().getAction())) root.post(this::showServerDialog);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (ACTION_SERVER.equals(intent.getAction())) root.post(this::showServerDialog);
        else if (ACTION_RELOAD.equals(intent.getAction())) reload();
    }

    private void createViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new FrameLayout.LayoutParams(-1, -1));

        FrameLayout page = new FrameLayout(this);
        content.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(245, 248, 252));
        page.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setVisibility(View.GONE);
        page.addView(progress, new FrameLayout.LayoutParams(-1, dp(2), Gravity.TOP));

        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(28), dp(20), dp(28), dp(20));
        errorPanel.setBackgroundColor(Color.rgb(245, 248, 252));
        TextView heading = new TextView(this);
        heading.setText(R.string.connection_error);
        heading.setTextSize(21);
        heading.setTextColor(INK);
        heading.setGravity(Gravity.CENTER);
        errorPanel.addView(heading);
        errorMessage = new TextView(this);
        errorMessage.setTextColor(Color.rgb(82, 111, 148));
        errorMessage.setTextSize(14);
        errorMessage.setGravity(Gravity.CENTER);
        errorMessage.setPadding(0, dp(14), 0, dp(20));
        errorPanel.addView(errorMessage);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> reload());
        errorPanel.addView(retry);
        Button change = new Button(this);
        change.setText(R.string.server);
        change.setOnClickListener(view -> showServerDialog());
        errorPanel.addView(change);
        errorPanel.setVisibility(View.GONE);
        page.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets cutout = insets.getInsets(WindowInsets.Type.displayCutout());
                int keyboard = insets.getInsets(WindowInsets.Type.ime()).bottom;
                view.setPadding(cutout.left, cutout.top, cutout.right, Math.max(cutout.bottom, keyboard));
                return insets;
            });
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (sameOrigin(uri, Uri.parse(serverUrl))) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                cancelMicrophoneRequest();
                pageFailed = false;
                errorPanel.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(getString(R.string.connection_help));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) showError(getString(R.string.connection_help));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError(getString(R.string.tls_error));
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!trustedMicrophoneOrigin(request) || microphoneRequest != null) { request.deny(); return; }
                    String[] resources = request.getResources();
                    if (resources.length != 1 || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0])) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        microphoneRequest = request;
                        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC_PERMISSION);
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphoneRequest == request) microphoneRequest = null;
            }

            @Override
            public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                if (value == 100 || pageFailed) progress.setVisibility(View.GONE);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                content.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(-1, -1));
                enterImmersiveMode();
            }

            @Override
            public void onHideCustomView() { exitFullscreen(); }
        });
    }

    private boolean trustedMicrophoneOrigin(PermissionRequest request) {
        Uri origin = request.getOrigin();
        return "https".equals(origin.getScheme()) && sameOrigin(origin, Uri.parse(serverUrl))
            && webView.getUrl() != null && sameOrigin(origin, Uri.parse(webView.getUrl()));
    }

    private void cancelMicrophoneRequest() {
        if (microphoneRequest != null) { microphoneRequest.deny(); microphoneRequest = null; }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode != MIC_PERMISSION || microphoneRequest == null) return;
        PermissionRequest request = microphoneRequest; microphoneRequest = null;
        if (grants.length == 1 && grants[0] == PackageManager.PERMISSION_GRANTED && trustedMicrophoneOrigin(request)) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else request.deny();
    }

    private void showServerDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl);
        input.setHint(R.string.server_hint);
        LinearLayout container = new LinearLayout(this);
        container.setPadding(dp(24), dp(8), dp(24), 0);
        container.addView(input, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.server).setView(container)
            .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.connect, null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String url = normalizeServerUrl(input.getText().toString());
            if (url == null) { input.setError(getString(R.string.invalid_url)); return; }
            serverUrl = url;
            getPreferences(MODE_PRIVATE).edit().putString("server_url", url).apply();
            webView.stopLoading();
            webView.clearHistory();
            webView.loadUrl(url);
            dialog.dismiss();
        }));
        dialog.show();
    }

    private static String normalizeServerUrl(String input) {
        try {
            URI uri = new URI(input.trim());
            String scheme = uri.getScheme();
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0) return null;
            String path = uri.getRawPath();
            return new URI(scheme.toLowerCase(java.util.Locale.ROOT), null, uri.getHost(), uri.getPort(),
                path == null || path.isEmpty() || "/".equals(path) ? "/live" : uri.getPath(), uri.getQuery(), null).toASCIIString();
        } catch (URISyntaxException exception) { return null; }
    }

    private static boolean sameOrigin(Uri left, Uri right) {
        int leftPort = left.getPort() == -1 ? ("https".equals(left.getScheme()) ? 443 : 80) : left.getPort();
        int rightPort = right.getPort() == -1 ? ("https".equals(right.getScheme()) ? 443 : 80) : right.getPort();
        return left.getScheme() != null && left.getScheme().equalsIgnoreCase(right.getScheme())
            && left.getHost() != null && left.getHost().equalsIgnoreCase(right.getHost()) && leftPort == rightPort;
    }

    private void reload() {
        exitFullscreen();
        if (pageFailed || webView.getUrl() == null) webView.loadUrl(serverUrl);
        else webView.reload();
    }

    private void showError(String message) {
        pageFailed = true;
        progress.setVisibility(View.GONE);
        errorMessage.setText(getString(R.string.error_details, message, serverUrl));
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsets.Type.systemBars());
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        content.setVisibility(View.VISIBLE);
        enterImmersiveMode();
        WebChromeClient.CustomViewCallback callback = fullscreenCallback;
        fullscreenCallback = null;
        if (callback != null) callback.onCustomViewHidden();
    }

    private void navigateBack() {
        if (fullscreenView != null) exitFullscreen();
        else if (webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { navigateBack(); }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onPause() {
        webView.evaluateJavascript("window.dispatchEvent(new Event('camera-station:stop-talk'));", null);
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        root.post(this::enterImmersiveMode);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    @Override
    protected void onDestroy() {
        cancelMicrophoneRequest();
        exitFullscreen();
        webView.stopLoading();
        ((FrameLayout) webView.getParent()).removeView(webView);
        webView.destroy();
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
