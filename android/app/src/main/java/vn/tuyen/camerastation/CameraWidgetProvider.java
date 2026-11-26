package vn.tuyen.camerastation;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.PersistableBundle;
import android.view.View;
import android.widget.RemoteViews;

public final class CameraWidgetProvider extends AppWidgetProvider {
    static SharedPreferences prefs(Context c){return c.getSharedPreferences("camera_widgets",Context.MODE_PRIVATE);}
    static void schedule(Context c,int id,boolean periodic){
        if(id<=0)return;
        PersistableBundle extras=new PersistableBundle();extras.putInt("widget",id);
        JobInfo.Builder builder=new JobInfo.Builder(100000+id*2+(periodic?1:0),new ComponentName(c,CameraWidgetJob.class)).setExtras(extras);
        // A manual refresh must run even without a network so it can show the error.
        if(periodic)builder.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15*60*1000L);else builder.setMinimumLatency(0);
        ((JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE)).schedule(builder.build());
    }
    static void display(Context c,int id,Bitmap bitmap,String message,String updated){
        SharedPreferences p=prefs(c);int camera=p.getInt("id_"+id,-1);
        RemoteViews view=new RemoteViews(c.getPackageName(),R.layout.camera_widget);
        String name=p.getString("name_"+id,"Camera");
        view.setTextViewText(R.id.widget_name,updated==null?name:name+" · "+updated);
        view.setTextViewText(R.id.widget_message,message==null?"":message);
        view.setViewVisibility(R.id.widget_message,message==null?View.GONE:View.VISIBLE);
        view.setImageViewBitmap(R.id.widget_image,bitmap);
        Intent open=new Intent(c,MainActivity.class).setAction("vn.tuyen.camerastation.WIDGET_OPEN."+id).putExtra("camera_widget_id",camera).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        view.setOnClickPendingIntent(R.id.widget_root,PendingIntent.getActivity(c,id,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));
        AppWidgetManager.getInstance(c).updateAppWidget(id,view);
    }
    @Override public void onUpdate(Context c,AppWidgetManager m,int[] ids){for(int id:ids){display(c,id,null,"Đang tải ảnh…",null);schedule(c,id,false);schedule(c,id,true);}}
    @Override public void onDeleted(Context c,int[] ids){JobScheduler jobs=(JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE);SharedPreferences.Editor edit=prefs(c).edit();for(int id:ids){jobs.cancel(100000+id*2);jobs.cancel(100001+id*2);edit.remove("id_"+id).remove("name_"+id).remove("origin_"+id);}edit.apply();}
}
