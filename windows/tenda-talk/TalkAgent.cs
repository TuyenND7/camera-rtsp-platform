using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

public sealed class TalkJob
{
    public string Directory;
    public FileStream Audio;
    public long Created, Consumed, Reported;
    public string LastState = "connecting";
    public volatile bool TalkReady, RecorderReady, Failed;
    public volatile int PcmCallbacks, ErrorCode;
}

public static partial class TalkAgent
{
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 16 };
    static readonly UTF8Encoding utf8 = new UTF8Encoding(false);
    static readonly Dictionary<int, TendaNative.Client> clients = new Dictionary<int, TendaNative.Client>();
    static string root, instance = Guid.NewGuid().ToString("D");
    static List<Dictionary<string, object>> bindings = new List<Dictionary<string, object>>();
    static readonly Dictionary<int, string> deviceIds = new Dictionary<int, string>();
    public static long Now { get { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; } }
    static Dictionary<string, object> Read(string path)
    {
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            if (file.Length > 16384) throw new Exception("ipc_size");
            using (var reader = new StreamReader(file, utf8)) return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
    }
    static void Write(string path, object value)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, json.Serialize(value), utf8);
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    static void State(string directory, string state, long consumed, int code, TalkJob job = null)
    {
        try { Write(Path.Combine(directory, "state.json"), new { state = state, consumed = consumed, code = code, talk_ready = job != null && job.TalkReady, recorder_ready = job != null && job.RecorderReady, pcm_callbacks = job == null ? 0 : job.PcmCallbacks }); } catch (IOException) {} catch (UnauthorizedAccessException) {}
    }
    static void Publish(bool authenticated)
    {
        try { Write(Path.Combine(root, "status.json"), new { version = 1, control_version = 1, settings_version = 1, instance = instance, updated_at = Now, authenticated = authenticated, bindings = bindings }); } catch (IOException) {}
    }
    static string Authorize(Dictionary<string, object> config)
    {
        string region = (string)config["region"];
        if (!new List<string> { "cn", "sa", "eu", "us" }.Contains(region)) throw new Exception("sdk_region_invalid");
        var request = (HttpWebRequest)WebRequest.Create("https://" + region + "-cloud.tenda.com.cn/td/td-user-api/internal/user/get/authCode/v1");
        request.Method = "GET"; request.Timeout = 10000; request.ReadWriteTimeout = 10000; request.AllowAutoRedirect = false;
        request.ContentType = "application/json";
        var headers = (Dictionary<string, object>)config["cloudHeaders"];
        foreach (string key in new string[] { "Terminal", "App-Id", "Project-Id", "AppSource", "terminal-os", "AppVersion", "td-lang", "Provider" })
            if (headers.ContainsKey(key)) request.Headers[key] = (string)headers[key];
        string timestamp = (Now / 1000 - 10).ToString();
        request.Headers["Timestamp"] = timestamp;
        using (var md5 = MD5.Create()) request.Headers["Sig"] = BitConverter.ToString(md5.ComputeHash(utf8.GetBytes((string)headers["Terminal"] + timestamp + (string)config["cloudSignatureSalt"]))).Replace("-", "").ToLowerInvariant();
        request.Headers["Authorization"] = "Bearer " + (string)config["accessToken"];
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), utf8))
        {
            var buffer = new char[16385]; int size = 0, count;
            while (size < buffer.Length && (count = reader.Read(buffer, size, buffer.Length - size)) > 0) size += count;
            if (size >= buffer.Length) throw new Exception("sdk_authorization_size");
            var result = json.Deserialize<Dictionary<string, object>>(new string(buffer, 0, size));
            if (Convert.ToInt32(result["code"]) != 0) throw new Exception("sdk_account_relink_required");
            string code = (string)((Dictionary<string, object>)result["data"])["auth_code"];
            if (string.IsNullOrEmpty(code) || code.Length > 4096) throw new Exception("sdk_authorization_invalid");
            return code;
        }
    }
    static Dictionary<string, object> Binding(int id)
    {
        return bindings.Find(b => Convert.ToInt32(b["id"]) == id);
    }
    static bool Command(string directory, Dictionary<string, object> command)
    {
        int id = Convert.ToInt32(command["camera_id"]); var binding = Binding(id);
        return Convert.ToInt32(command["version"]) == 1 && (string)command["agent_instance"] == instance &&
            Math.Abs(Now - Convert.ToInt64(command["created_at"])) < 10000 && binding != null && (string)command["url_hash"] == (string)binding["url_hash"] &&
            File.Exists(Path.Combine(directory, "audio.pcm")) && File.Exists(Path.Combine(directory, "heartbeat"));
    }
    static void Open(string directory, Dictionary<string, object> config)
    {
        try
        {
            var command = Read(Path.Combine(directory, "start.json"));
            if (!Command(directory, command)) { State(directory, "error", 0, 403); return; }
            int id = Convert.ToInt32(command["camera_id"]); TendaNative.Client client;
            if (!clients.TryGetValue(id, out client))
            {
                client = new TendaNative.Client(deviceIds[id]); clients[id] = client;
            }
            if (client.Job != null || client.AvailableAfter > Now) { State(directory, "error", 0, 409); return; }
            var job = new TalkJob { Directory = directory, Created = Now, Audio = new FileStream(Path.Combine(directory, "audio.pcm"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete) };
            State(directory, "connecting", 0, 0); client.Open(job);
        }
        catch { State(directory, "error", 0, 502); }
    }
    static void Tick(Dictionary<string, object> config, bool discover = true)
    {
        foreach (var client in clients.Values)
        {
            TalkJob job = client.Job;
            if (job == null) continue;
            bool stopped = File.Exists(Path.Combine(job.Directory, "stop"));
            bool expired = Now - job.Created >= 60000 || Now - new DateTimeOffset(File.GetLastWriteTimeUtc(Path.Combine(job.Directory, "heartbeat"))).ToUnixTimeMilliseconds() > 1500;
            bool ready = job.TalkReady && job.RecorderReady && job.PcmCallbacks > 0;
            if (job.Failed || stopped || expired || (!ready && Now - job.Created > 10000))
            {
                if (!job.Failed && !stopped) job.ErrorCode = expired ? 40801 : 40802;
                client.Close(); State(job.Directory, job.Failed || (!ready && !stopped) ? "error" : "closed", job.Consumed, job.ErrorCode, job);
            }
            else
            {
                string state = ready ? "ready" : "connecting";
                if (state != job.LastState || Now - job.Reported >= 200)
                {
                    State(job.Directory, state, job.Consumed, 0, job); job.LastState = state; job.Reported = Now;
                }
            }
        }
        if (!discover) return;
        int scanned = 0;
        foreach (string directory in Directory.GetDirectories(root))
        {
            if (++scanned > 128) break;
            Guid nonce;
            if (!Guid.TryParseExact(Path.GetFileName(directory), "D", out nonce) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
            if (File.Exists(Path.Combine(directory, "state.json")))
            {
                // Only our expired voice sessions are removed; recording folders
                // are outside this private IPC directory.
                bool active = false; foreach (var client in clients.Values) if (client.Job != null && client.Job.Directory == directory) active = true;
                if (!active && Now - new DateTimeOffset(Directory.GetLastWriteTimeUtc(directory)).ToUnixTimeMilliseconds() > 60000) try { Directory.Delete(directory, true); } catch (IOException) {}
                continue;
            }
            if (File.Exists(Path.Combine(directory, "start.json"))) Open(directory, config);
        }
    }
    static Dictionary<string, object> Configuration(string path)
    {
        byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), utf8.GetBytes("CameraStation.TendaTalk.v1"), DataProtectionScope.LocalMachine);
        var config = json.Deserialize<Dictionary<string, object>>(utf8.GetString(bytes)); Array.Clear(bytes, 0, bytes.Length);
        var devices = (System.Collections.IEnumerable)config["bindings"];
        var ids = new HashSet<int>();
        foreach (Dictionary<string, object> device in devices)
        {
            int id = Convert.ToInt32(device["id"]); string model = (string)device["model"];
            if (id < 1 || !ids.Add(id) || ids.Count > 16 || !Regex.IsMatch((string)device["url_hash"], "^[a-f0-9]{64}$") || !Regex.IsMatch((string)device["iotId"], "^[A-Za-z0-9]{20,128}$") || (model != "CT3V1.0" && model != "RH7V2.0")) throw new Exception("sdk_bindings_invalid");
            deviceIds[id] = (string)device["iotId"];
            bindings.Add(new Dictionary<string, object> { { "id", id }, { "url_hash", device["url_hash"] }, { "model", model } });
        }
        if (ids.Count == 0) throw new Exception("sdk_bindings_invalid");
        return config;
    }
    public static void Main(string[] args)
    {
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string configuration = Path.GetFullPath(args[0]);
            var config = Configuration(configuration); root = Path.GetFullPath((string)config["ipcDirectory"]);
            if (Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar)) != ".tenda-talk") throw new Exception("sdk_ipc_directory_invalid");
            Directory.CreateDirectory(root);
            if (args.Length > 2)
            {
                Guid generation;
                if (!Guid.TryParseExact(args[2], "D", out generation)) throw new Exception("sdk_generation_invalid");
                instance = generation.ToString("D");
                if (args[1] == "--control") RunControl(configuration, config, args);
                else RunWorker(configuration, config, args);
            }
            else
            {
                bool created;
                using (var mutex = new Mutex(true, "Global\\CameraStationTendaTalkSDK", out created))
                {
                    if (!created) return;
                    try { RunBroker(configuration); } finally { mutex.ReleaseMutex(); }
                }
            }
        }
        catch (Exception error)
        {
            string code = Regex.IsMatch(error.Message, "^sdk_[a-z_]+$") ? error.Message : "sdk_agent_failed";
            Console.Error.WriteLine(code + ":" + error.GetType().Name); Environment.ExitCode = 1;
        }
        Environment.Exit(Environment.ExitCode);
    }
}
