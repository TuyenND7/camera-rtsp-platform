using System;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.IO;
public static class CameraSdkPcmSource  {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int CoCreate(ref Guid cls,IntPtr outer,uint context,ref Guid iid,out IntPtr value);
    [DllImport("kernel32",SetLastError=true)] static extern bool VirtualProtect(IntPtr address,UIntPtr length,uint protection,out uint old);
    [DllImport("kernel32")] static extern bool SetEvent(IntPtr handle);
    static CoCreate original,replacement;
    static readonly Guid clsid=new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static void Install(IntPtr module,string path) {
        using(SHA256 sha=SHA256.Create()) {
            string hash=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(path))).Replace("-","").ToLowerInvariant();
            if(hash!="bdc1e36b1283ab37e9790096e09922ff072d80a72524515c08f162639cdb9171")throw new Exception("unrecognized_media_sdk");
        }
        IntPtr slot=IntPtr.Add(module,0x1531f0);
        original=(CoCreate)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(slot),typeof(CoCreate));
        replacement=Create;
        uint old;
        if(!VirtualProtect(slot,(UIntPtr)8,4,out old))throw new Exception("pcm_input_unavailable");
        Marshal.WriteIntPtr(slot,Marshal.GetFunctionPointerForDelegate(replacement));
        uint ignored;
        VirtualProtect(slot,(UIntPtr)8,old,out ignored);
    }
    static int Create(ref Guid cls,IntPtr outer,uint context,ref Guid iid,out IntPtr value) {
        object obj;
        if(cls==clsid)obj=new Devices();
        else if(cls==new Guid("745057C7-F353-4F2D-A7EE-58434477730E")) {
            obj=new CameraSdkPcmDmo.Source();
        }
        else return original(ref cls,outer,context,ref iid,out value);
        IntPtr unknown=Marshal.GetIUnknownForObject(obj);
        int result=Marshal.QueryInterface(unknown,ref iid,out value);
        Marshal.Release(unknown);
        return result;
    }
    static int Pointer(object obj,Type type,out IntPtr ptr) {
        ptr=Marshal.GetComInterfaceForObject(obj,type);
        return 0;
    }
    [ComVisible(true),Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IDevices  {
        [PreserveSig]int EnumAudioEndpoints(int flow,uint state,out IntPtr devices);
        [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IntPtr device);
        [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out IntPtr device);
        [PreserveSig]int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig]int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Devices:IDevices  {
        public int EnumAudioEndpoints(int flow,uint state,out IntPtr devices) {
            return Pointer(new Collection(),typeof(ICollection),out devices);
        }
        public int GetDefaultAudioEndpoint(int flow,int role,out IntPtr device) {
            return Pointer(new Device(),typeof(IDevice),out device);
        }
        public int GetDevice(string id,out IntPtr device) {
            return Pointer(new Device(),typeof(IDevice),out device);
        }
        public int RegisterEndpointNotificationCallback(IntPtr callback) {
            return 0;
        }
        public int UnregisterEndpointNotificationCallback(IntPtr callback) {
            return 0;
        }
    }
    [ComVisible(true),Guid("0BD7A1BE-7A1A-44DB-8397-C0A359383E17"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface ICollection  {
        [PreserveSig]int GetCount(out uint count);
        [PreserveSig]int Item(uint index,out IntPtr device);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Collection:ICollection  {
        public int GetCount(out uint count) {
            count=1;
            return 0;
        }
        public int Item(uint index,out IntPtr device) {
            return Pointer(new Device(),typeof(IDevice),out device);
        }
    }
    [ComVisible(true),Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IDevice  {
        [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr parameters,out IntPtr value);
        [PreserveSig]int OpenPropertyStore(uint access,out IntPtr store);
        [PreserveSig]int GetId(out IntPtr id);
        [PreserveSig]int GetState(out uint state);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Device:IDevice  {
        public int Activate(ref Guid iid,uint context,IntPtr parameters,out IntPtr value) {
            if(iid==typeof(IAudio).GUID)return Pointer(new Audio(),typeof(IAudio),out value);
            value=IntPtr.Zero;
            return unchecked((int)0x80004002);
        }
        public int OpenPropertyStore(uint access,out IntPtr store) {
            return Pointer(new Properties(),typeof(IProperties),out store);
        }
        public int GetId(out IntPtr id) {
            id=Marshal.StringToCoTaskMemUni("CameraStation web PCM");
            return 0;
        }
        public int GetState(out uint state) {
            state=1;
            return 0;
        }
    }
    [StructLayout(LayoutKind.Sequential)]public struct PropertyKey  {
        public Guid guid;
        public uint id;
    }
    [ComVisible(true),Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IProperties  {
        [PreserveSig]int GetCount(out uint count);
        [PreserveSig]int GetAt(uint index,out PropertyKey key);
        [PreserveSig]int GetValue(ref PropertyKey key,IntPtr value);
        [PreserveSig]int SetValue(ref PropertyKey key,IntPtr value);
        [PreserveSig]int Commit();
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)]public class Properties:IProperties  {
        public int GetCount(out uint count) {
            count=1;
            return 0;
        }
        public int GetAt(uint index,out PropertyKey key) {
            key=new PropertyKey();
            key.guid=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
            key.id=14;
            return 0;
        }
        public int GetValue(ref PropertyKey key,IntPtr value) {
            Marshal.Copy(new byte[24],0,value,24);
            Marshal.WriteInt16(value,31);
            Marshal.WriteIntPtr(value,8,Marshal.StringToCoTaskMemUni("CameraStation web PCM"));
            return 0;
        }
        public int SetValue(ref PropertyKey key,IntPtr value) {
            return unchecked((int)0x80004001);
        }
        public int Commit() {
            return 0;
        }
    }
    [ComVisible(true),Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IAudio  {
        [PreserveSig]int Initialize(int mode,uint flags,long duration,long periodicity,IntPtr format,IntPtr session);
        [PreserveSig]int GetBufferSize(out uint frames);
        [PreserveSig]int GetStreamLatency(out long latency);
        [PreserveSig]int GetCurrentPadding(out uint frames);
        [PreserveSig]int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);
        [PreserveSig]int GetMixFormat(out IntPtr format);
        [PreserveSig]int GetDevicePeriod(out long normal,out long minimum);
        [PreserveSig]int Start();
        [PreserveSig]int Stop();
        [PreserveSig]int Reset();
        [PreserveSig]int SetEventHandle(IntPtr handle);
        [PreserveSig]int GetService(ref Guid iid,out IntPtr service);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Audio:IAudio  {
        internal volatile bool started;
        internal long next;
        internal IntPtr handle;
        internal Timer timer;
        public int Initialize(int mode,uint flags,long duration,long periodicity,IntPtr format,IntPtr session) {
            return 0;
        }
        public int GetBufferSize(out uint frames) {
            frames=160;
            return 0;
        }
        public int GetStreamLatency(out long latency) {
            latency=200000;
            return 0;
        }
        public int GetCurrentPadding(out uint frames) {
            frames=0;
            return 0;
        }
        public int IsFormatSupported(int mode,IntPtr format,out IntPtr closest) {
            closest=IntPtr.Zero;
            return 0;
        }
        public int GetMixFormat(out IntPtr format) {
            byte[] b=new byte[] {
                1,0,1,0,64,31,0,0,128,62,0,0,2,0,16,0,0,0
            }
            ;
            format=Marshal.AllocCoTaskMem(18);
            Marshal.Copy(b,0,format,18);
            return 0;
        }
        public int GetDevicePeriod(out long normal,out long minimum) {
            normal=200000;
            minimum=100000;
            return 0;
        }
        public int Start() {
            started=true;
            next=Stopwatch.GetTimestamp();
            timer=new Timer(delegate(object o) {
                if(started&&handle!=IntPtr.Zero)SetEvent(handle);
            }
            ,null,0,20);
            return 0;
        }
        public int Stop() {
            started=false;
            if(timer!=null) {
                timer.Dispose();
                timer=null;
            }
            return 0;
        }
        public int Reset() {
            next=Stopwatch.GetTimestamp();
            return 0;
        }
        public int SetEventHandle(IntPtr value) {
            handle=value;
            return 0;
        }
        public int GetService(ref Guid iid,out IntPtr service) {
            if(iid==typeof(ICapture).GUID)return Pointer(new Capture(this),typeof(ICapture),out service);
            if(iid==typeof(IRender).GUID)return Pointer(new Render(),typeof(IRender),out service);
            service=IntPtr.Zero;
            return unchecked((int)0x80004002);
        }
    }
    [ComVisible(true),Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IRender  {
        [PreserveSig]int GetBuffer(uint frames,out IntPtr data);
        [PreserveSig]int ReleaseBuffer(uint frames,uint flags);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Render:IRender  {
        IntPtr buffer=Marshal.AllocHGlobal(65536);
        public int GetBuffer(uint frames,out IntPtr data) {
            data=frames<=32768?buffer:IntPtr.Zero;
            return data==IntPtr.Zero?unchecked((int)0x88890006):0;
        }
        public int ReleaseBuffer(uint frames,uint flags) {
            return 0;
        }
        ~Render() {
            Marshal.FreeHGlobal(buffer);
        }
    }
    [ComVisible(true),Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface ICapture  {
        [PreserveSig]int GetBuffer(out IntPtr data,out uint frames,out uint flags,out ulong position,out ulong time);
        [PreserveSig]int ReleaseBuffer(uint frames);
        [PreserveSig]int GetNextPacketSize(out uint frames);
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public class Capture:ICapture  {
        Audio client;
        IntPtr data=Marshal.AllocHGlobal(320);
        ulong position;
        public Capture(Audio c) {
            client=c;
            Marshal.Copy(new byte[320],0,data,320);
        }
        public int GetBuffer(out IntPtr p,out uint frames,out uint flags,out ulong pos,out ulong time) {
            p=data;
            frames=160;
            flags=0;
            pos=position;
            time=(ulong)(Stopwatch.GetTimestamp()*(10000000d/Stopwatch.Frequency));
            return 0;
        }
        public int ReleaseBuffer(uint frames) {
            position+=frames;
            long now=Stopwatch.GetTimestamp();
            client.next+=Stopwatch.Frequency/50;
            if(client.next<now-Stopwatch.Frequency/10)client.next=now+Stopwatch.Frequency/50;
            return 0;
        }
        public int GetNextPacketSize(out uint frames) {
            frames=client.started&&Stopwatch.GetTimestamp()>=client.next?160u:0u;
            return 0;
        }
        ~Capture() {
            Marshal.FreeHGlobal(data);
        }
    }
}
