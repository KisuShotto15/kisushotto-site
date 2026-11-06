package com.kisushotto.habits;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.StrikethroughSpan;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.ArrayList;
import java.util.List;

public class HabitsWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context ctx;
        private List<HabitsApi.Item> items = new ArrayList<>();

        Factory(Context ctx) { this.ctx = ctx; }

        @Override public void onCreate() {}
        @Override public void onDestroy() {}

        /** Corre en un hilo de fondo: aqui si se puede usar la red. */
        @Override
        public void onDataSetChanged() {
            String date = HabitsApi.today();
            boolean useCache = HabitsWidget.skipFetch && date.equals(HabitsApi.cacheDate);
            HabitsWidget.skipFetch = false;
            if (!useCache) {
                try {
                    HabitsApi.cache = HabitsApi.fetch(ctx, date);
                    HabitsApi.cacheDate = date;
                    HabitsApi.lastError = false;
                } catch (Exception e) {
                    HabitsApi.lastError = true;
                    if (!date.equals(HabitsApi.cacheDate)) HabitsApi.cache = new ArrayList<>();
                }
            }
            items = new ArrayList<>(HabitsApi.cache);
            HabitsWidget.updateHeader(ctx, AppWidgetManager.getInstance(ctx),
                    AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, HabitsWidget.class)));
        }

        @Override public int getCount() { return items.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_item);
            if (position >= items.size()) return rv;
            HabitsApi.Item it = items.get(position);

            String label = (it.emoji == null || it.emoji.isEmpty() ? "" : it.emoji + "  ") + it.name;
            if (it.done) {
                SpannableString s = new SpannableString(label);
                s.setSpan(new StrikethroughSpan(), 0, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                rv.setTextViewText(R.id.item_text, s);
                rv.setTextColor(R.id.item_text, ctx.getResources().getColor(R.color.widget_muted));
                rv.setImageViewResource(R.id.item_check, R.drawable.widget_check_on);
            } else {
                rv.setTextViewText(R.id.item_text, label);
                rv.setTextColor(R.id.item_text, Color.parseColor("#ECE9FF"));
                rv.setImageViewResource(R.id.item_check, R.drawable.widget_check_off);
            }

            Intent fill = new Intent();
            fill.putExtra(HabitsWidget.EXTRA_HABIT_ID, it.id);
            rv.setOnClickFillInIntent(R.id.item_root, fill);
            return rv;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
