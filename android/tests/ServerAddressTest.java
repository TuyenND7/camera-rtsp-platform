package vn.tuyen.camerastation;

public final class ServerAddressTest {
    private static void equal(String expected, String actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        String target = ServerAddress.DEFAULT_URL;
        equal(target, ServerAddress.initialUrl(null, false));
        for (String old : new String[] {"http://camera.local:8081", "http://camera:8081/live", "http://192.168.0.101:8081/live", "https://camera.taild8cb98.ts.net/live", "https://CAMERA.taild8cb98.ts.net:443/live"}) equal(target, ServerAddress.initialUrl(old, false));
        equal("https://camera.taild8cb98.ts.net:8443/playback/3?day=20261115", ServerAddress.initialUrl("http://camera.local:8081/playback/3?day=20261115", false));
        // A user can deliberately switch back to LAN after this one-time migration.
        equal("http://camera.local:8081/live", ServerAddress.initialUrl("http://camera.local:8081/live", true));
        for (String custom : new String[] {"https://example.com/live", "http://127.0.0.1:18173/live", "https://camera.taild8cb98.ts.net:10000/live", "http://192.168.0.102:8081/live", target}) equal(custom, ServerAddress.initialUrl(custom, false));
        for (String invalid : new String[] {"https://user:pass@example.com", "https://example.com/#fragment", "file:///etc/passwd", "https://example.com:0", "https://example.com:65536", "javascript:alert(1)"}) equal(null, ServerAddress.normalize(invalid));
        equal(target, ServerAddress.normalize(" https://camera.taild8cb98.ts.net:8443/ "));
        System.out.println("PASS: public default, known-origin migration, path/query preserved, custom URLs and manual LAN choice preserved, URL security validation.");
    }
}
