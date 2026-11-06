package com.kisushotto.habits;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Cliente minimo de habits-worker para el widget. Llamar fuera del hilo principal. */
final class HabitsApi {

    static final class Item {
        String id, name, emoji, type;
        int target;
        boolean done;
    }

    /** Ultima lista conocida; la comparten el proveedor y el servicio del widget. */
    static volatile List<Item> cache = new ArrayList<>();
    static volatile String cacheDate = "";
    static volatile boolean lastError = false;

    private HabitsApi() {}

    static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    static List<Item> fetch(Context c, String date) throws Exception {
        JSONObject res = new JSONObject(request(c, "GET", "/widget?date=" + date, null));
        JSONArray arr = res.getJSONArray("items");
        List<Item> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            Item it = new Item();
            it.id = o.getString("id");
            it.name = o.optString("name");
            it.emoji = o.optString("emoji");
            it.type = o.optString("type");
            it.target = o.optInt("target_value", 1);
            it.done = o.optBoolean("done");
            out.add(it);
        }
        return out;
    }

    static void setDone(Context c, String habitId, String date, int value) throws Exception {
        JSONObject b = new JSONObject();
        b.put("habit_id", habitId);
        b.put("date", date);
        b.put("value", value);
        request(c, "POST", "/completions/set", b.toString());
    }

    private static String request(Context c, String method, String path, String body) throws Exception {
        URL url = new URL(c.getString(R.string.widget_api_base) + path);
        HttpURLConnection con = (HttpURLConnection) url.openConnection();
        try {
            con.setRequestMethod(method);
            con.setConnectTimeout(10000);
            con.setReadTimeout(15000);
            con.setRequestProperty("Authorization", "Bearer " + c.getString(R.string.widget_api_token));
            con.setRequestProperty("X-User-Email", c.getString(R.string.widget_user_email));
            con.setRequestProperty("Content-Type", "application/json");
            if (body != null) {
                con.setDoOutput(true);
                OutputStream os = con.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.close();
            }
            int code = con.getResponseCode();
            InputStream is = code < 400 ? con.getInputStream() : con.getErrorStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (is != null) {
                byte[] b = new byte[4096];
                int n;
                while ((n = is.read(b)) > 0) buf.write(b, 0, n);
                is.close();
            }
            String text = buf.toString("UTF-8");
            if (code >= 400) throw new Exception("HTTP " + code + ": " + text);
            return text;
        } finally {
            con.disconnect();
        }
    }
}
