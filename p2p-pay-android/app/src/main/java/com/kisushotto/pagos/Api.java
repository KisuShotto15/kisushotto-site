package com.kisushotto.pagos;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** POST {path, params} al router de la app, con el token del telefono. Llamar fuera del hilo principal. */
final class Api {
    static final String URL_API = "https://kisushotto-site.vercel.app/api/binance-bot";

    static JSONObject call(String token, String path, JSONObject params) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(URL_API).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000);
        c.setReadTimeout(45000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        if (token != null) c.setRequestProperty("x-device-token", token);
        JSONObject body = new JSONObject().put("path", path).put("params", params == null ? new JSONObject() : params);
        try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        int code = c.getResponseCode();
        InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (is != null) { byte[] b = new byte[8192]; int n; while ((n = is.read(b)) > 0) bo.write(b, 0, n); is.close(); }
        String txt = bo.toString("UTF-8");
        JSONObject j = txt.isEmpty() ? new JSONObject() : new JSONObject(txt);
        j.put("_status", code);
        return j;
    }
}
