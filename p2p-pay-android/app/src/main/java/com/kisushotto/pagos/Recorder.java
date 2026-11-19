package com.kisushotto.pagos;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Modo aprendizaje: graba la estructura de las pantallas de BDV (arbol de vistas:
 * clase, id, textos, si es editable/tocable y posicion) y la secuencia de toques y
 * campos editados, para despues programar el pago automatico sobre ids reales.
 * Nada de capturas de pantalla. Los numeros largos (cuentas, cedulas, montos) se
 * enmascaran dejando los ultimos 4 digitos, y los campos de clave solo su largo.
 */
final class Recorder {
    static volatile boolean recording = false;
    static final List<JSONObject> items = new ArrayList<>();
    static final Map<String, String> versions = new HashMap<>();
    static long startedAt = 0;
    static int screens = 0;
    private static String lastHash = "";
    private static final int MAX_ITEMS = 1500;

    // Paquetes que nunca se graban (la propia app, sistema, launcher, teclados).
    private static final Pattern SKIP = Pattern.compile(
            "^(com\\.kisushotto\\.pagos|com\\.android\\.systemui|android|com\\.android\\.settings)$|launcher|inputmethod|keyboard|\\.ime$|gboard|swiftkey");
    private static final Pattern DIGITS = Pattern.compile("\\d[\\d .,-]{4,}\\d");

    static synchronized void start() {
        items.clear(); versions.clear(); lastHash = ""; screens = 0;
        startedAt = System.currentTimeMillis();
        recording = true;
    }
    static synchronized void stop() { recording = false; }
    static synchronized int count() { return items.size(); }

    static boolean skip(CharSequence pkg) {
        return pkg == null || SKIP.matcher(pkg.toString()).find();
    }

    static String mask(CharSequence cs) {
        if (cs == null) return null;
        String s = cs.toString();
        Matcher m = DIGITS.matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String d = m.group().replaceAll("\\D", "");
            String rep = d.length() >= 5 ? "#" + d.length() + "…" + d.substring(d.length() - 4) : m.group();
            m.appendReplacement(out, Matcher.quoteReplacement(rep));
        }
        m.appendTail(out);
        return out.length() > 160 ? out.substring(0, 160) + "…" : out.toString();
    }

    static JSONObject node(AccessibilityNodeInfo n, int depth) throws JSONException {
        JSONObject o = new JSONObject();
        if (n.getClassName() != null) {
            String c = n.getClassName().toString();
            o.put("c", c.substring(c.lastIndexOf('.') + 1));
        }
        if (n.getViewIdResourceName() != null) o.put("id", n.getViewIdResourceName());
        if (n.isPassword()) {
            o.put("pw", true);
            o.put("tx", "<clave " + (n.getText() == null ? 0 : n.getText().length()) + ">");
        } else if (n.getText() != null && n.getText().length() > 0) {
            o.put("tx", mask(n.getText()));
        }
        if (n.getContentDescription() != null && n.getContentDescription().length() > 0) o.put("d", mask(n.getContentDescription()));
        if (n.getHintText() != null && n.getHintText().length() > 0) o.put("h", mask(n.getHintText()));
        if (n.isEditable()) o.put("e", true);
        if (n.isClickable()) o.put("k", true);
        if (n.isCheckable()) o.put("chk", n.isChecked());
        if (n.isScrollable()) o.put("s", true);
        if (!n.isEnabled()) o.put("off", true);
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        o.put("b", r.left + "," + r.top + "," + r.right + "," + r.bottom);
        if (depth < 40 && n.getChildCount() > 0) {
            JSONArray ch = new JSONArray();
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = n.getChild(i);
                if (c == null) continue;
                if (c.isVisibleToUser()) ch.put(node(c, depth + 1));
            }
            if (ch.length() > 0) o.put("ch", ch);
        }
        return o;
    }

    private static synchronized void add(JSONObject o) {
        if (items.size() < MAX_ITEMS) items.add(o);
    }

    /** Pantalla completa (solo si cambio respecto de la anterior). */
    static void snapshot(AccessibilityNodeInfo root, String reason) {
        if (!recording || root == null || skip(root.getPackageName())) return;
        try {
            JSONObject tree = node(root, 0);
            String h = Integer.toHexString(tree.toString().hashCode());
            synchronized (Recorder.class) {
                if (h.equals(lastHash)) return;
                lastHash = h;
                screens++;
            }
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis() - startedAt);
            o.put("ev", "screen");
            o.put("why", reason);
            o.put("pkg", String.valueOf(root.getPackageName()));
            o.put("tree", tree);
            add(o);
        } catch (Exception ignored) { }
    }

    /** Toques y textos escritos: la secuencia de pasos de una transferencia. */
    static void event(AccessibilityEvent e) {
        if (!recording || skip(e.getPackageName())) return;
        String type;
        switch (e.getEventType()) {
            case AccessibilityEvent.TYPE_VIEW_CLICKED: type = "click"; break;
            case AccessibilityEvent.TYPE_VIEW_LONG_CLICKED: type = "long_click"; break;
            case AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED: type = "text"; break;
            case AccessibilityEvent.TYPE_VIEW_FOCUSED: type = "focus"; break;
            case AccessibilityEvent.TYPE_VIEW_SELECTED: type = "select"; break;
            default: return;
        }
        try {
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis() - startedAt);
            o.put("ev", type);
            o.put("pkg", String.valueOf(e.getPackageName()));
            if (e.getClassName() != null) o.put("c", e.getClassName().toString());
            AccessibilityNodeInfo src = e.getSource();
            if (src != null) {
                if (src.getViewIdResourceName() != null) o.put("id", src.getViewIdResourceName());
                if (src.isPassword()) o.put("pw", true);
                Rect r = new Rect();
                src.getBoundsInScreen(r);
                o.put("b", r.left + "," + r.top + "," + r.right + "," + r.bottom);
            }
            CharSequence tx = e.getText() != null && !e.getText().isEmpty() ? e.getText().get(0) : null;
            if (src != null && src.isPassword()) o.put("tx", "<clave " + (tx == null ? 0 : tx.length()) + ">");
            else if (tx != null) o.put("tx", mask(tx));
            if (e.getContentDescription() != null) o.put("d", mask(e.getContentDescription()));
            add(o);
        } catch (Exception ignored) { }
    }

    static synchronized String toJson(int w, int h) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("app", "ks-pagos " + BuildConfigLite.VERSION);
        o.put("android", android.os.Build.VERSION.RELEASE);
        o.put("device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        o.put("screen", w + "x" + h);
        o.put("startedAt", startedAt);
        o.put("versions", new JSONObject(versions));
        o.put("items", new JSONArray(items));
        return o.toString();
    }
}
