package vn.tuyen.camerastation;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.graphics.Bitmap;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CameraWidgetJob extends JobService {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    @Override public boolean onStartJob(JobParameters params){
        int widget=params.getExtras().getInt("widget",-1);
        worker.execute(()->{
            try {
                boolean exists=false;for(int id:AppWidgetManager.getInstance(this).getAppWidgetIds(new ComponentName(this,CameraWidgetProvider.class)))if(id==widget)exists=true;
                if(!exists)return;
                int camera=CameraWidgetProvider.prefs(this).getInt("id_"+widget,-1);
                String origin=CameraWidgetProvider.prefs(this).getString("origin_"+widget,"");
                if(camera<=0)return;
                Bitmap bitmap=CameraWidgetData.image(this,camera,origin);
                CameraWidgetProvider.display(this,widget,bitmap,null,DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date()));
            } catch(Exception e){CameraWidgetProvider.display(this,widget,null,e.getMessage()==null?"Không tải được ảnh":e.getMessage(),null);}
            finally {jobFinished(params,false);}
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params){return false;}
    @Override public void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
