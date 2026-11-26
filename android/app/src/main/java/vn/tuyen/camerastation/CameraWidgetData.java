package vn.tuyen.camerastation;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.webkit.CookieManager;
import org.json.JSONArray;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Authenticated requests to the configured server only; never opens RTSP. */
final class CameraWidgetData {
    static final int MAX_SEGMENT = 16 * 1024 * 1024;
    static String origin(Context context) throws Exception {
        String saved = context.getSharedPreferences("MainActivity", Context.MODE_PRIVATE).getString("server_url", ServerAddress.DEFAULT_URL);
        String normalized = ServerAddress.normalize(saved);
        if (normalized == null) throw new Exception("Địa chỉ máy chủ không hợp lệ");
        URI u = new URI(normalized);
        return new URI(u.getScheme(), null, u.getHost(), u.getPort(), null, null, null).toASCIIString();
    }
    static byte[] get(String origin, String path, int limit) throws Exception {
        if (!path.startsWith("/") || path.startsWith("//")) throw new Exception("Đường dẫn không hợp lệ");
        URL url = new URL(origin + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000); connection.setReadTimeout(12000);
        connection.setRequestProperty("Cache-Control", "no-cache");
        String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
        try {
            int code = connection.getResponseCode();
            if (code == 401 || code == 403) throw new Exception("Mở app để đăng nhập lại");
            if (code != 200) throw new Exception("Chưa kết nối được máy chủ");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int n,total=0;
                while ((n=in.read(buffer))!=-1) { total+=n; if (total>limit) throw new Exception("Ảnh camera quá lớn"); out.write(buffer,0,n); }
                return out.toByteArray();
            }
        } catch (IOException error) { throw new Exception("Chưa kết nối được máy chủ", error); }
        finally { connection.disconnect(); }
    }
    static JSONArray cameras(Context context) throws Exception {
        return new JSONArray(new String(get(origin(context), "/api/cameras", 1024*1024), StandardCharsets.UTF_8));
    }
    static Bitmap image(Context context, int id, String expectedOrigin) throws Exception {
        String currentOrigin=origin(context);
        if (!currentOrigin.equals(expectedOrigin)) throw new Exception("Máy chủ đã đổi. Hãy thêm lại widget");
        JSONArray cameras=cameras(context); boolean online=false;
        for(int n=0;n<cameras.length();n++) {
            org.json.JSONObject camera=cameras.optJSONObject(n);
            if(camera!=null&&camera.optInt("id",-1)==id) {online=camera.optBoolean("enabled")&&"online".equals(camera.optString("status"));break;}
        }
        if(!online)throw new Exception("Camera chưa trực tuyến");
        String playlist=new String(get(currentOrigin,"/live/"+id+"/index.m3u8",256*1024),StandardCharsets.UTF_8);
        String segment=null; boolean complete=false;
        for (String raw:playlist.split("\\r?\\n")) {
            String line=raw.trim();
            if (line.startsWith("#EXTINF:")) complete=true;
            else if (!line.isEmpty() && !line.startsWith("#")) { if (complete && line.matches("seg_[0-9]+\\.ts")) segment=line; complete=false; }
        }
        if (segment == null) throw new Exception("Camera chưa có hình mới");
        byte[] bytes=get(currentOrigin,"/live/"+id+"/"+segment,MAX_SEGMENT);
        File file=File.createTempFile("widget-", ".ts", context.getCacheDir());
        try {
            try(FileOutputStream out=new FileOutputStream(file)){out.write(bytes);}
            MediaMetadataRetriever decoder=new MediaMetadataRetriever(); Bitmap frame;
            try {decoder.setDataSource(file.getAbsolutePath());frame=decoder.getFrameAtTime(-1,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);}
            catch (RuntimeException error) {throw new Exception("Không đọc được ảnh camera",error);}
            finally {decoder.release();}
            if(frame==null)throw new Exception("Không đọc được ảnh camera");
            int width=frame.getWidth(),height=frame.getHeight(); float scale=Math.min(1f,Math.min(640f/width,360f/height));
            if(scale<1f){Bitmap resized=Bitmap.createScaledBitmap(frame,Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)),true);if(resized!=frame)frame.recycle();frame=resized;}
            return frame;
        } finally {file.delete();}
    }
}
