using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Security.Cryptography;
using System.Reflection;

// Interop is pinned to the verified TDSEE Studio 1.0.7 runtime. The proprietary
// DLLs and application/account credentials are supplied outside this repository.
public static partial class TendaNative
{
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibrary(string name);
    [DllImport("kernel32", CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern bool SetDllDirectory(string path);
    [DllImport("ucrtbase", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr malloc(UIntPtr size);
    [DllImport("kernel32")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr length, out UIntPtr read);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr Factory();
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr Create(IntPtr header);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void Init(IntPtr obj, IntPtr config);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void Country(IntPtr obj, IntPtr code, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr Login(IntPtr obj, IntPtr output, IntPtr authCode, IntPtr callback);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate byte IsLogin(IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void Log(int level, IntPtr text, int length, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void SetLog(Log log, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void Callback(IntPtr self, IntPtr a, IntPtr b, IntPtr c, IntPtr d);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr Destructor(IntPtr self, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int SetCallback(IntPtr obj, IntPtr callback, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int SetInt(IntPtr obj, int value);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int External(IntPtr obj, [MarshalAs(UnmanagedType.I1)] bool use, IntPtr callback, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] [return:MarshalAs(UnmanagedType.I1)] delegate bool Pcm(IntPtr self, IntPtr data, int length, IntPtr user);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Start(IntPtr obj, IntPtr iotId);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Stop(IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void Destroy(ref IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void QtConstructor(IntPtr self, IntPtr argc, IntPtr argv, int version);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void QtEvents(int flags, int duration);

    // Delegates/COM input providers live as long as their SDK objects. Clients
    // are reused per configured camera, keeping the number of handles bounded.
    static readonly List<Delegate> keep = new List<Delegate>();
    static QtEvents events;
    static IntPtr media, account, accountLibrary;
    static volatile bool invalidCredential;
    const string isLoginExport = "?isLogin@IotOpenAccountImpl@@UEAA_NXZ";
    public static bool Authenticated { get { return !invalidCredential && account != IntPtr.Zero && Function<IsLogin>(accountLibrary, isLoginExport)(account) != 0; } }

    static T Function<T>(IntPtr dll, string name) where T:class
    {
        IntPtr p = GetProcAddress(dll, name);
        if (p == IntPtr.Zero) throw new Exception("sdk_export_missing");
        return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }
    static T Method<T>(IntPtr obj, int slot) where T:class
    {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * 8), typeof(T)) as T;
    }
    static IntPtr Zero(int bytes)
    {
        IntPtr p = Marshal.AllocHGlobal(bytes); Marshal.Copy(new byte[bytes], 0, p, bytes); return p;
    }
    static void StringAt(IntPtr obj, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length <= 15) { Marshal.Copy(bytes, 0, obj, bytes.Length); Marshal.WriteInt64(obj, 24, 15); }
        else
        {
            IntPtr data = malloc((UIntPtr)(bytes.Length + 1)); Marshal.Copy(bytes, 0, data, bytes.Length);
            Marshal.WriteByte(data, bytes.Length, 0); Marshal.WriteIntPtr(obj, data); Marshal.WriteInt64(obj, 24, bytes.Length);
        }
        Marshal.WriteInt64(obj, 16, bytes.Length);
    }
    static IntPtr Str(string text) { IntPtr p = Zero(32); StringAt(p, text); return p; }
    static IntPtr Callbacks(int count, Action<int, IntPtr> action, bool destructor)
    {
        IntPtr vt = Zero(count * 8);
        for (int i = 0; i < count; i++)
        {
            int index = i; Delegate callback;
            if (i == 0 && destructor) callback = new Destructor(delegate(IntPtr self, uint flags) { return self; });
            else callback = new Callback(delegate(IntPtr self, IntPtr a, IntPtr b, IntPtr c, IntPtr d) { try { if (action != null) action(index, a); } catch { invalidCredential = true; } });
            keep.Add(callback); Marshal.WriteIntPtr(vt, i * 8, Marshal.GetFunctionPointerForDelegate(callback));
        }
        IntPtr obj = Zero(8); Marshal.WriteIntPtr(obj, vt); return obj;
    }
    public static void Pump(int milliseconds)
    {
        var time = Stopwatch.StartNew();
        do { events(0, 5); Thread.Sleep(5); } while (time.ElapsedMilliseconds < milliseconds);
    }
    static bool Wait(AutoResetEvent signal, int milliseconds)
    {
        var time = Stopwatch.StartNew();
        while (time.ElapsedMilliseconds < milliseconds) { if (signal.WaitOne(0)) return true; Pump(5); }
        return false;
    }
    static void CreateQt(string directory)
    {
        IntPtr lib = LoadLibrary(Path.Combine(directory, "Qt5Core.dll"));
        string[] version = Marshal.PtrToStringAnsi(Function<Factory>(lib, "qVersion")()).Split('.');
        int flags = (int.Parse(version[0]) << 16) | (int.Parse(version[1]) << 8) | int.Parse(version[2]);
        IntPtr argc = Zero(4), argv = Zero(16); Marshal.WriteInt32(argc, 1);
        Marshal.WriteIntPtr(argv, Marshal.StringToHGlobalAnsi(Assembly.GetExecutingAssembly().Location));
        Function<QtConstructor>(lib, "??0QCoreApplication@@QEAA@AEAHPEAPEADH@Z")(Zero(512), argc, argv, flags);
        events = Function<QtEvents>(lib, "?processEvents@QCoreApplication@@SAXV?$QFlags@W4ProcessEventsFlag@QEventLoop@@@@H@Z");
    }
    static void VerifyRuntime(string directory)
    {
        using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("RuntimeHashes.json")))
        {
            var hashes = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(reader.ReadToEnd());
            foreach (var item in hashes)
                using (var sha = SHA256.Create())
                    if (BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(Path.Combine(directory, item.Key)))).Replace("-", "").ToLowerInvariant() != item.Value)
                        throw new Exception("sdk_runtime_version_mismatch");
        }
    }
    public static void Initialize(string directory, Dictionary<string, object> config, Func<string> authorize)
    {
        if (IntPtr.Size != 8) throw new Exception("sdk_requires_x64");
        VerifyRuntime(directory); Directory.SetCurrentDirectory(directory); SetDllDirectory(directory);
        IntPtr common = LoadLibrary(Path.Combine(directory, "iotcommon.dll"));
        if (common == IntPtr.Zero) throw new Exception("sdk_load_failed");
        // The vendor's diagnostic messages can include signed URLs and tokens.
        Log logger = delegate(int level, IntPtr text, int length, IntPtr user) {};
        keep.Add(logger); Function<SetLog>(common, "SetLVLogCallback")(logger, IntPtr.Zero);
        IntPtr smartLibrary = LoadLibrary(Path.Combine(directory, "iotsmart.dll"));
        accountLibrary = LoadLibrary(Path.Combine(directory, "iotoa.dll"));
        media = LoadLibrary(Path.Combine(directory, "lvmedia.dll"));
        if (smartLibrary == IntPtr.Zero || accountLibrary == IntPtr.Zero || media == IntPtr.Zero) throw new Exception("sdk_load_failed");
        CreateQt(directory); CameraSdkPcmSource.Install(media, Path.Combine(directory, "lvmedia.dll"));
        IntPtr smart = Function<Factory>(smartLibrary, "getSharedIotSmart")(), init = Zero(80);
        Marshal.WriteInt32(init, 0, 1); StringAt(IntPtr.Add(init, 16), (string)config["appKey"]); StringAt(IntPtr.Add(init, 48), (string)config["encryptedAppSecret"]);
        Method<Init>(smart, 1)(smart, init);
        Method<Country>(smart, 5)(smart, Str("VN"), Callbacks(4, null, false)); Pump(800);
        account = Function<Factory>(accountLibrary, "getSharedIotOpenAccount")();
        var initialized = new AutoResetEvent(false); var loggedIn = new AutoResetEvent(false);
        Function<Init>(accountLibrary, "?init@IotOpenAccountImpl@@UEAAXPEAVIIotOaInitCallback@@@Z")(account,
            Callbacks(8, delegate(int i, IntPtr value) { if (i == 0 || i == 1) initialized.Set(); else invalidCredential = true; }, false));
        if (!Wait(initialized, 15000)) throw new Exception("sdk_init_timeout");
        if (!Authenticated)
        {
            string authCode = authorize();
            Function<Login>(accountLibrary, "?loginByOAuth@IotOpenAccountImpl@@UEAA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@V23@PEAVIIotOaCallback@@@Z")(
                account, Zero(32), Str(authCode), Callbacks(8, delegate(int i, IntPtr value) { loggedIn.Set(); }, false));
            if (!Wait(loggedIn, 15000) || !Authenticated) throw new Exception("sdk_account_unavailable");
        }
    }
    public sealed class Client
    {
        IntPtr handle;
        readonly object sync = new object();
        public TalkJob Job;
        public long AvailableAfter;
        readonly string iotId;
        public Client(string id)
        {
            iotId = id; IntPtr header = Zero(16); Marshal.Copy(new int[] { 16, 8000, 1, 1 }, 0, header, 4);
            handle = Function<Create>(media, "createLVLiveIntercom")(header);
            if (handle == IntPtr.Zero) throw new Exception("sdk_intercom_create_failed");
            Method<SetCallback>(handle, 7)(handle, Callbacks(8, OnEvent, true), IntPtr.Zero);
            Method<SetInt>(handle, 9)(handle, -1);
            Pcm callback = OnPcm; Destructor destroy = delegate(IntPtr self, uint flags) { return self; };
            keep.Add(callback); keep.Add(destroy);
            IntPtr vt = Zero(16); Marshal.WriteIntPtr(vt, Marshal.GetFunctionPointerForDelegate(destroy)); Marshal.WriteIntPtr(vt, 8, Marshal.GetFunctionPointerForDelegate(callback));
            IntPtr source = Zero(8); Marshal.WriteIntPtr(source, vt);
            Method<External>(handle, 11)(handle, true, source, IntPtr.Zero);
        }
        void OnEvent(int index, IntPtr value)
        {
            lock (sync)
            {
                if (Job == null) return;
                if (index == 1)
                {
                    byte[] error = new byte[8]; UIntPtr read;
                    if (ReadProcessMemory(new IntPtr(-1), value, error, (UIntPtr)8, out read)) Job.ErrorCode = BitConverter.ToInt32(error, 0);
                    Job.Failed = true;
                }
                else if (index == 2) Job.TalkReady = true;
                else if (index == 3) Job.RecorderReady = true;
                else if (index == 4) Job.Failed = true;
            }
        }
        bool OnPcm(IntPtr self, IntPtr data, int length, IntPtr user)
        {
            if (length < 0 || length > 6400 || length % 2 != 0) return false;
            byte[] bytes = new byte[length];
            lock (sync)
            {
                if (Job != null && !Job.Failed)
                {
                    try
                    {
                        if (Job.Audio.Length - Job.Audio.Position > 8000) Job.Failed = true;
                        else
                        {
                            int available = (int)Math.Min(length, Job.Audio.Length - Job.Audio.Position);
                            int read = Job.Audio.Read(bytes, 0, available); Job.Consumed += read; Job.PcmCallbacks++;
                        }
                    }
                    catch { Job.Failed = true; }
                }
            }
            Marshal.Copy(bytes, 0, data, length); return true;
        }
        public void Open(TalkJob job)
        {
            lock (sync) { if (Job != null) throw new Exception("sdk_camera_busy"); Job = job; }
            // Select the mode for every call: idle clients are reused.
            Method<SetInt>(handle, 8)(handle, job.Duplex ? 1 : 0);
            if (Method<Start>(handle, 1)(handle, Str(iotId)) != 0) job.Failed = true;
        }
        public void Close()
        {
            TalkJob job;
            lock (sync) { job = Job; Job = null; if (job != null) job.Audio.Dispose(); }
            if (job != null) Method<Stop>(handle, 3)(handle);
            AvailableAfter = TalkAgent.Now + 1000;
        }
        public void Destroy()
        {
            Close(); Pump(200);
            if (handle != IntPtr.Zero) Function<Destroy>(media, "destroyLVLiveIntercom")(ref handle);
        }
    }
}
