package vn.tuyen.camerastation;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android launcher invokes this once for each widget instance. */
public final class CameraWidgetConfigure extends Activity {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private int widgetId; private LinearLayout content; private TextView status;
    @Override public void onCreate(Bundle state){
        super.onCreate(state);setResult(RESULT_CANCELED);
        widgetId=getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,AppWidgetManager.INVALID_APPWIDGET_ID);
        if(widgetId==AppWidgetManager.INVALID_APPWIDGET_ID){finish();return;}
        android.appwidget.AppWidgetProviderInfo info=AppWidgetManager.getInstance(this).getAppWidgetInfo(widgetId);
        if(info==null||!getPackageName().equals(info.provider.getPackageName())){finish();return;}
        LinearLayout outer=new LinearLayout(this);outer.setOrientation(LinearLayout.VERTICAL);outer.setPadding(dp(24),dp(22),dp(24),dp(20));
        TextView title=new TextView(this);title.setText("Chọn camera cho widget");title.setTextSize(22);title.setTextColor(0xff1f3b60);title.setGravity(Gravity.CENTER);outer.addView(title);
        status=new TextView(this);status.setText("Đang tải danh sách camera…");status.setTextSize(15);status.setPadding(0,dp(18),0,dp(12));outer.addView(status);
        ScrollView scroll=new ScrollView(this);content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);scroll.addView(content);outer.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        Button cancel=new Button(this);cancel.setText("Hủy");cancel.setAllCaps(false);cancel.setOnClickListener(v->finish());outer.addView(cancel);setContentView(outer);
        load();
    }
    private void load(){worker.execute(()->{try{
        String origin=CameraWidgetData.origin(this);JSONArray cameras=CameraWidgetData.cameras(this);
        runOnUiThread(()->{if(isFinishing())return;status.setText(cameras.length()==0?"Chưa có camera":"Chọn một camera. Chạm widget để mở Live.");
            for(int n=0;n<cameras.length();n++){JSONObject camera=cameras.optJSONObject(n);if(camera==null)continue;int id=camera.optInt("id",-1);if(id<=0)continue;String name=camera.optString("name","Camera");String cameraStatus=camera.optString("status","");
                Button button=new Button(this);button.setAllCaps(false);button.setText(name+ ("online".equals(cameraStatus)?"  ·  Trực tuyến":"  ·  Chưa trực tuyến"));button.setMinHeight(dp(52));button.setOnClickListener(v->select(id,name,origin));content.addView(button);}
        });
        }catch(Exception error){runOnUiThread(()->{if(isFinishing())return;status.setText(error.getMessage()==null?"Chưa tải được camera":error.getMessage());Button open=new Button(this);open.setAllCaps(false);open.setText("Mở Camera Station");open.setOnClickListener(v->startActivity(new Intent(this,MainActivity.class)));content.addView(open);Button retry=new Button(this);retry.setAllCaps(false);retry.setText("Thử lại");retry.setOnClickListener(v->{content.removeAllViews();status.setText("Đang tải danh sách camera…");load();});content.addView(retry);});}});}
    private void select(int camera,String name,String origin){
        CameraWidgetProvider.prefs(this).edit().putInt("id_"+widgetId,camera).putString("name_"+widgetId,name).putString("origin_"+widgetId,origin).apply();
        CameraWidgetProvider.display(this,widgetId,null,"Đang tải ảnh…",null);CameraWidgetProvider.schedule(this,widgetId,false);CameraWidgetProvider.schedule(this,widgetId,true);
        Intent result=new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,widgetId);setResult(RESULT_OK,result);finish();
    }
    private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
    @Override public void onDestroy(){worker.shutdownNow();super.onDestroy();}
}
