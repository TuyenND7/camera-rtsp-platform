using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// IIotThing and MSVC std::function layout are pinned to the verified runtime.
// Each control worker exits after its request, bounding all native allocations.
public static partial class TendaNative
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr ThingBuild(IntPtr self, IntPtr id);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ThingGet(IntPtr self, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ThingSet(IntPtr self, IntPtr data, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void ThingInvoke(IntPtr self, IntPtr name, IntPtr data, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr FunctionCopy(IntPtr self, IntPtr where);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void FunctionCall(IntPtr self, IntPtr success, IntPtr data, IntPtr code, IntPtr message, IntPtr localized);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void FunctionDelete(IntPtr self, byte destroy);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr FunctionPointer(IntPtr self);

    static string ReadNativeString(IntPtr value)
    {
        long length = Marshal.ReadInt64(value, 16);
        if (length < 0 || length > 1048576) throw new Exception("sdk_result_size");
        var bytes = new byte[(int)length];
        Marshal.Copy(Marshal.ReadInt64(value, 24) < 16 ? value : Marshal.ReadIntPtr(value), bytes, 0, bytes.Length);
        return Encoding.UTF8.GetString(bytes);
    }

    sealed class ThingFunction
    {
        public IntPtr Value;
        public string Data;
        public bool Success;
        public int Code;
        public readonly AutoResetEvent Signal = new AutoResetEvent(false);
        public ThingFunction()
        {
            IntPtr table = Zero(48);
            FunctionCopy copy = delegate(IntPtr self, IntPtr where) {
                if (where == IntPtr.Zero) where = Zero(16);
                Marshal.WriteIntPtr(where, table); return where;
            };
            FunctionCall call = delegate(IntPtr self, IntPtr success, IntPtr data, IntPtr code, IntPtr message, IntPtr localized) {
                try { Success = Marshal.ReadByte(success) != 0; Code = Marshal.ReadInt32(code); Data = ReadNativeString(data); }
                catch { Success = false; Code = -1; }
                Signal.Set();
            };
            FunctionDelete delete = delegate(IntPtr self, byte destroy) {};
            FunctionPointer pointer = delegate(IntPtr self) { return self; };
            Delegate[] callbacks = { copy, copy, call, pointer, delete, pointer };
            for (int i = 0; i < callbacks.Length; i++) { keep.Add(callbacks[i]); Marshal.WriteIntPtr(table, i * 8, Marshal.GetFunctionPointerForDelegate(callbacks[i])); }
            Value = Zero(64); Marshal.WriteIntPtr(Value, table); Marshal.WriteIntPtr(Value, 56, Value);
        }
    }

    public sealed class ThingClient
    {
        readonly IntPtr handle;
        readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 1048576 };
        public ThingClient(string iotId)
        {
            IntPtr library = LoadLibrary(Path.Combine(Path.GetDirectoryName(typeof(TendaNative).Assembly.Location), "iottmp.dll"));
            if (library == IntPtr.Zero) throw new Exception("sdk_control_load_failed");
            IntPtr manager = Function<Factory>(library, "getSharedIotTingManager")();
            handle = Method<ThingBuild>(manager, 0)(manager, Str(iotId));
            if (handle == IntPtr.Zero) throw new Exception("sdk_control_create_failed");
        }
        string Complete(ThingFunction callback)
        {
            if (!Wait(callback.Signal, 8000)) throw new Exception("sdk_control_timeout");
            if (!callback.Success) throw new Exception("sdk_control_rejected");
            return callback.Data;
        }
        public Dictionary<string, object> Properties()
        {
            var callback = new ThingFunction(); Method<ThingGet>(handle, 5)(handle, callback.Value);
            return serializer.Deserialize<Dictionary<string, object>>(Complete(callback));
        }
        public void Light(bool enabled)
        {
            var callback = new ThingFunction();
            Method<ThingSet>(handle, 6)(handle, Str("{\"TurnLight\":" + (enabled ? "1" : "0") + "}"), callback.Value);
            Complete(callback);
        }
        public void Alarm(bool enabled)
        {
            var callback = new ThingFunction();
            Method<ThingInvoke>(handle, 10)(handle, Str("oneKeyAlarm"), Str("{\"operate\":" + (enabled ? "1" : "0") + "}"), callback.Value);
            Complete(callback);
        }
    }
}
