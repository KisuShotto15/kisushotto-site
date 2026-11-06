package com.kisushotto.habits;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

import java.util.Calendar;

/** Widget de pantalla principal: habitos de hoy; tocar uno lo marca/desmarca. */
public class HabitsWidget extends AppWidgetProvider {

    static final String ACTION_TOGGLE  = "com.kisushotto.habits.widget.TOGGLE";
    static final String ACTION_REFRESH = "com.kisushotto.habits.widget.REFRESH";
    static final String EXTRA_HABIT_ID = "habit_id";

    /** true = el proximo onDataSetChanged pinta la cache sin ir a la red (cambio optimista). */
    static volatile boolean skipFetch = false;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx, id));
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
        scheduleMidnight(ctx);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)) {
            refreshAll(ctx, false);
            scheduleMidnight(ctx);
        } else if (ACTION_TOGGLE.equals(action)) {
            toggle(ctx, intent.getStringExtra(EXTRA_HABIT_ID));
        }
    }

    private void toggle(final Context ctx, final String habitId) {
        if (habitId == null) return;
        HabitsApi.Item target = null;
        for (HabitsApi.Item it : HabitsApi.cache) if (habitId.equals(it.id)) target = it;
        if (target == null) { refreshAll(ctx, false); return; }

        // Cambio optimista: se tacha al instante y luego se confirma con el servidor.
        target.done = !target.done;
        final int value = target.done ? Math.max(target.target, 1) : 0;
        final String date = HabitsApi.cacheDate;
        refreshAll(ctx, true);

        final PendingResult pending = goAsync();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    HabitsApi.setDone(ctx, habitId, date, value);
                } catch (Exception e) {
                    HabitsApi.lastError = true;
                } finally {
                    refreshAll(ctx, false);
                    pending.finish();
                }
            }
        }).start();
    }

    static void refreshAll(Context ctx, boolean fromCache) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, HabitsWidget.class));
        if (ids.length == 0) return;
        skipFetch = fromCache;
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    static void updateHeader(Context ctx, AppWidgetManager mgr, int[] ids) {
        int done = 0, total = HabitsApi.cache.size();
        for (HabitsApi.Item it : HabitsApi.cache) if (it.done) done++;
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_habits);
        rv.setTextViewText(R.id.widget_progress, total > 0 ? done + "/" + total : "");
        rv.setTextViewText(R.id.widget_empty, ctx.getString(
                HabitsApi.lastError && total == 0 ? R.string.widget_error : R.string.widget_empty));
        for (int id : ids) mgr.partiallyUpdateAppWidget(id, rv);
    }

    private static RemoteViews build(Context ctx, int widgetId) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_habits);

        Intent svc = new Intent(ctx, HabitsWidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        rv.setRemoteAdapter(R.id.widget_list, svc);
        rv.setEmptyView(R.id.widget_list, R.id.widget_empty);

        Intent toggle = new Intent(ctx, HabitsWidget.class).setAction(ACTION_TOGGLE);
        int mutable = Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0;
        rv.setPendingIntentTemplate(R.id.widget_list,
                PendingIntent.getBroadcast(ctx, 0, toggle, PendingIntent.FLAG_UPDATE_CURRENT | mutable));

        rv.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(ctx));

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            rv.setOnClickPendingIntent(R.id.widget_title,
                    PendingIntent.getActivity(ctx, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable()));
        }
        return rv;
    }

    private static PendingIntent refreshIntent(Context ctx) {
        Intent i = new Intent(ctx, HabitsWidget.class).setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | immutable());
    }

    private static int immutable() {
        return Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    /** Recarga la lista justo despues de medianoche para empezar el dia en blanco. */
    private static void scheduleMidnight(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Calendar c = Calendar.getInstance();
        c.add(Calendar.DAY_OF_YEAR, 1);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 1);
        c.set(Calendar.SECOND, 0);
        am.set(AlarmManager.RTC, c.getTimeInMillis(), refreshIntent(ctx));
    }
}
