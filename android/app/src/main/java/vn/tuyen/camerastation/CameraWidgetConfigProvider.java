package vn.tuyen.camerastation;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

/** Only a same-signature launcher may read the non-secret camera selection. */
public final class CameraWidgetConfigProvider extends ContentProvider {
    @Override public boolean onCreate(){return true;}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){
        MatrixCursor result=new MatrixCursor(new String[]{"camera_id","name","origin"});
        if(getContext()==null || uri.getPathSegments().size()!=1)return result;
        try {
            int widget=Integer.parseInt(uri.getLastPathSegment());
            AppWidgetProviderInfo info=AppWidgetManager.getInstance(getContext()).getAppWidgetInfo(widget);
            if(info==null||!getContext().getPackageName().equals(info.provider.getPackageName()))return result;
            android.content.SharedPreferences prefs=CameraWidgetProvider.prefs(getContext());
            int camera=prefs.getInt("id_"+widget,-1);String origin=prefs.getString("origin_"+widget,"");
            if(!origin.isEmpty())result.addRow(new Object[]{camera,prefs.getString("name_"+widget,"Camera"),origin});
        }catch(NumberFormatException ignored){}
        return result;
    }
    @Override public String getType(Uri uri){return "vnd.android.cursor.item/vnd.camerastation.widget";}
    @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
}
