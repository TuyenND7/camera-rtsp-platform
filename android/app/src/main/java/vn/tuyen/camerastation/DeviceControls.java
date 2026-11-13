package vn.tuyen.camerastation;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.provider.Settings;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;

/** Only the configured HTTPS main frame can adjust this viewing device. */
final class DeviceControls {
    private static final String BRIDGE = "CameraStationDevice";
    private final Activity activity;
    private final WebView webView;
    private final FrameLayout root;
    private final AudioManager audio;
    private final SharedPreferences preferences;
    private String trustedOrigin;
    private boolean installed;
    private JavaScriptReplyProxy reply;
    private FrameLayout curtain;
    private View previousFocus;

    DeviceControls(Activity activity, WebView webView, FrameLayout root) {
        this.activity = activity; this.webView = webView; this.root = root;
        audio = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        preferences = activity.getSharedPreferences("viewing_device", Context.MODE_PRIVATE);
        applyBrightness();
    }

    private static String origin(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) return null;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        return "https://" + host + ":" + (uri.getPort() == -1 ? 443 : uri.getPort());
    }

    void configure(String serverUrl) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        if (installed) { WebViewCompat.removeWebMessageListener(webView, BRIDGE); installed = false; }
        reply = null; trustedOrigin = origin(Uri.parse(serverUrl));
        if (trustedOrigin == null) return;
        final String allowedOrigin = trustedOrigin;
        WebViewCompat.addWebMessageListener(webView, BRIDGE, Collections.singleton(allowedOrigin), (view, message, source, mainFrame, proxy) -> {
            if (!mainFrame || !allowedOrigin.equals(trustedOrigin) || !allowedOrigin.equals(origin(source)) || view.getUrl() == null || !allowedOrigin.equals(origin(Uri.parse(view.getUrl())))) return;
            String id = null;
            try {
                String text = message.getData();
                if (text == null || text.length() > 2048) return;
                JSONObject command = new JSONObject(text);
                id = command.getString("id");
                if (!id.matches("[A-Za-z0-9-]{1,80}")) return;
                Iterator<String> keys = command.keys();
                while (keys.hasNext()) if (!java.util.Arrays.asList("id", "action", "value").contains(keys.next())) throw new IllegalArgumentException();
                String action = command.getString("action");
                boolean setting = "volume".equals(action) || "brightness".equals(action);
                if (command.length() != (setting ? 3 : 2)) throw new IllegalArgumentException();
                if (setting) {
                    Object raw = command.get("value");
                    if (!(raw instanceof Integer)) throw new IllegalArgumentException();
                    int value = (Integer) raw;
                    if ("volume".equals(action)) {
                        if (value < 0 || value > 100 || audio.isVolumeFixed()) throw new IllegalArgumentException();
                        audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * value / 100f), 0);
                    } else {
                        if (value != -1 && (value < 1 || value > 100)) throw new IllegalArgumentException();
                        preferences.edit().putInt("brightness", value).apply(); applyBrightness();
                    }
                } else if ("sleep".equals(action)) sleep();
                else if ("wake".equals(action)) wake();
                else if (!"get".equals(action)) throw new IllegalArgumentException();
                reply = proxy;
                proxy.postMessage(new JSONObject().put("id", id).put("ok", true).put("state", state()).toString());
            } catch (Exception error) {
                if (id != null) try { proxy.postMessage(new JSONObject().put("id", id).put("ok", false).put("error", "Chưa áp dụng được điều khiển thiết bị.").toString()); } catch (Exception ignored) { }
            }
        });
        installed = true;
    }

    private JSONObject state() throws Exception {
        int max = Math.max(1, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int brightness = Settings.System.getInt(activity.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, 128);
        return new JSONObject().put("version", 1).put("volume_percent", Math.round(audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max))
            .put("volume_supported", !audio.isVolumeFixed()).put("brightness_percent", preferences.getInt("brightness", -1))
            .put("system_brightness_percent", Math.max(1, Math.min(100, Math.round(brightness * 100f / 255))))
            .put("sleeping", curtain != null);
    }

    private void applyBrightness() {
        WindowManager.LayoutParams params = activity.getWindow().getAttributes();
        int percent = preferences.getInt("brightness", -1);
        params.screenBrightness = curtain != null ? 0f : percent < 0 ? -1f : percent / 100f;
        activity.getWindow().setAttributes(params);
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private void sleep() {
        if (curtain != null) return;
        webView.evaluateJavascript("window.dispatchEvent(new Event('camera-station:stop-talk'));", null);
        previousFocus = root.findFocus();
        curtain = new FrameLayout(activity); curtain.setBackgroundColor(Color.BLACK);
        TextView hint = new TextView(activity); hint.setText(R.string.screen_sleep_hint); hint.setTextColor(Color.GRAY); hint.setTextSize(14); hint.setGravity(Gravity.CENTER);
        curtain.addView(hint, new FrameLayout.LayoutParams(-1, -1)); hint.animate().alpha(0f).setStartDelay(1800).setDuration(400).start();
        GestureDetector detector = new GestureDetector(activity, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent event) { return true; }
            @Override public boolean onDoubleTap(MotionEvent event) { wake(); return true; }
        });
        curtain.setContentDescription(activity.getString(R.string.screen_sleep_description));
        curtain.setOnTouchListener((view, event) -> { detector.onTouchEvent(event); return true; });
        curtain.setOnClickListener(view -> wake());
        curtain.setFocusableInTouchMode(true);
        curtain.setOnKeyListener((view, code, event) -> {
            if (event.getAction() == KeyEvent.ACTION_UP && (code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_SPACE || code == KeyEvent.KEYCODE_DPAD_CENTER)) { wake(); return true; }
            return false;
        });
        root.addView(curtain, new FrameLayout.LayoutParams(-1, -1)); curtain.requestFocus(); applyBrightness();
    }

    boolean sleeping() { return curtain != null; }
    void bringToFront() { if (curtain != null) curtain.bringToFront(); }
    void pageStarted() { reply = null; wake(); }
    void wake() {
        if (curtain == null) return;
        root.removeView(curtain); curtain = null; applyBrightness();
        if (previousFocus != null && previousFocus.isAttachedToWindow()) previousFocus.requestFocus(); previousFocus = null;
        if (reply != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) try { reply.postMessage(new JSONObject().put("event", "state").put("state", state()).toString()); } catch (Exception ignored) { }
    }
    void dispose() {
        wake(); reply = null;
        if (installed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(webView, BRIDGE);
    }
}
