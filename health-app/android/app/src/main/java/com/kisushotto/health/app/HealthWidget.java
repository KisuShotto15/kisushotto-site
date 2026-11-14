package com.kisushotto.health.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

// Widget de la pantalla de inicio: "Hoy toca …", anillo del dia completo (x/3) y
// racha. Los datos los manda la web (NativePlugin.widget) cada vez que pinta Hoy.
public class HealthWidget extends AppWidgetProvider {

    static final String PREFS = "widget";

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) m.updateAppWidget(id, views(c));
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, HealthWidget.class));
        for (int id : ids) m.updateAppWidget(id, views(c));
    }

    private static String mark(boolean done, String label) {
        return (done ? "✓ " : "○ ") + label;
    }

    static RemoteViews views(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean today = p.getString("day", "").equals(new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date()));
        int ring = today ? p.getInt("ring", 0) : 0;
        boolean rut = today && p.getBoolean("rut", false);
        boolean food = today && p.getBoolean("food", false);
        boolean weight = today && p.getBoolean("weight", false);
        int streak = p.getInt("streak", 0);

        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_health);
        v.setTextViewText(R.id.w_title, p.getString("title", "Tu rutina"));
        v.setTextViewText(R.id.w_label, rut ? "Hoy ya entrenaste" : "Hoy toca");
        v.setProgressBar(R.id.w_ring, 3, ring, false);
        v.setTextViewText(R.id.w_count, ring + "/3");
        v.setTextViewText(R.id.w_checks, mark(rut, "Rutina") + "   " + mark(food, "Comida") + "   " + mark(weight, "Peso"));
        v.setTextViewText(R.id.w_streak, streak > 0 ? "🔥 " + streak + (streak == 1 ? " día completo" : " días completos") : "Empieza tu racha hoy");
        v.setOnClickPendingIntent(R.id.w_root, PushService.openIntent(c, rut ? "/#hoy" : "/#rutina"));
        return v;
    }
}
