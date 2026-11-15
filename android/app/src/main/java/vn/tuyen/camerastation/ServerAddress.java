package vn.tuyen.camerastation;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class ServerAddress {
    static final String DEFAULT_URL = "https://camera.taild8cb98.ts.net:8443/live";

    private ServerAddress() {}

    static String initialUrl(String saved, boolean migrated) {
        if (saved == null) return DEFAULT_URL;
        if (migrated) return saved;
        String normalized = normalize(saved);
        if (normalized == null) return saved;
        URI uri = URI.create(normalized);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        boolean privateTailscale = "https".equals(uri.getScheme())
            && "camera.taild8cb98.ts.net".equals(host)
            && (uri.getPort() == -1 || uri.getPort() == 443);
        boolean previousLan = "http".equals(uri.getScheme()) && uri.getPort() == 8081
            && ("camera.local".equals(host) || "camera".equals(host)
                || "192.168.0.101".equals(host) || "100.67.230.38".equals(host)
                || "100.106.130.39".equals(host));
        if (!privateTailscale && !previousLan) return saved;
        try {
            URI target = URI.create(DEFAULT_URL);
            return new URI(target.getScheme(), null, target.getHost(), target.getPort(),
                uri.getPath(), uri.getQuery(), null).toASCIIString();
        } catch (URISyntaxException exception) { return DEFAULT_URL; }
    }

    static String normalize(String input) {
        if (input == null) return null;
        try {
            URI uri = new URI(input.trim());
            String scheme = uri.getScheme();
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0) return null;
            String path = uri.getRawPath();
            return new URI(scheme.toLowerCase(Locale.ROOT), null, uri.getHost(), uri.getPort(),
                path == null || path.isEmpty() || "/".equals(path) ? "/live" : uri.getPath(), uri.getQuery(), null).toASCIIString();
        } catch (URISyntaxException exception) { return null; }
    }
}
