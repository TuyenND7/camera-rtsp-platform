using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;

public sealed class DeviceControlState
{
    public bool alarm_supported, light_supported, talking;
    public bool? alarm_active, light_enabled;
    public long? alarm_reported_at, light_reported_at;
    public long observed_at;
    public DeviceSettingsSnapshot device_settings;
}

public static partial class TalkAgent
{
    sealed class ControlFailure : Exception
    {
        public int Status;
        public ControlFailure(int status, string message) : base(message) { Status = status; }
    }
    static string ControlRoot { get { return Path.Combine(root, "controls"); } }
    static object Property(Dictionary<string, object> properties, string name)
    {
        object raw, value;
        if (!properties.TryGetValue(name, out raw)) return null;
        var item = raw as Dictionary<string, object>;
        return item != null && item.TryGetValue("value", out value) ? value : null;
    }
    static bool? Switch(object value)
    {
        if (value == null) return null;
        string text = Convert.ToString(value);
        return text == "1" ? true : text == "0" ? (bool?)false : null;
    }
    static long? Reported(Dictionary<string, object> properties, string name)
    {
        object raw, time;
        if (!properties.TryGetValue(name, out raw)) return null;
        var item = raw as Dictionary<string, object>; long result;
        return item != null && item.TryGetValue("time", out time) && long.TryParse(Convert.ToString(time), out result) ? result : (long?)null;
    }
    static DeviceControlState ControlState(TendaNative.ThingClient client)
    {
        return ControlStateFromProperties(client.Properties());
    }
    static DeviceControlState ControlStateFromProperties(Dictionary<string, object> properties)
    {
        var functions = Property(properties, "FunctionSet") as Dictionary<string, object>;
        object alarm = null; if (functions != null) functions.TryGetValue("oneKeyAlarm", out alarm);
        return new DeviceControlState {
            alarm_supported = Switch(alarm) == true && properties.ContainsKey("AudibleStatus"),
            light_supported = properties.ContainsKey("TurnLight"),
            // AudibleStatus does not change for oneKeyAlarm on the tested CT3.
            // Keep physical siren state unknown; the timed command lease is
            // exposed separately and must not masquerade as speaker feedback.
            alarm_active = null,
            light_enabled = Switch(Property(properties, "TurnLight")),
            talking = Switch(Property(properties, "TalkBackStartEnable")) == true,
            alarm_reported_at = Reported(properties, "AudibleStatus"),
            light_reported_at = Reported(properties, "TurnLight"), observed_at = Now,
            device_settings = SettingsFromProperties(properties)
        };
    }
    static DeviceControlState ConfirmControl(TendaNative.ThingClient client, string action, bool enabled)
    {
        DeviceControlState state = null;
        for (int i = 0; i < 5; i++) {
            state = ControlState(client);
            if ((action == "alarm" ? state.alarm_active : state.light_enabled) == enabled) break;
            TendaNative.Pump(400);
        }
        return state;
    }
    static Dictionary<string, object> ControlCommand(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new ControlFailure(400, "sdk_control_request_invalid");
        string file = Path.Combine(directory, "request.json");
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new ControlFailure(400, "sdk_control_request_invalid");
        var command = Read(file); int id = Convert.ToInt32(command["camera_id"]); var binding = Binding(id);
        if (Convert.ToInt32(command["version"]) != 1 || (string)command["agent_instance"] != instance || Math.Abs(Now - Convert.ToInt64(command["created_at"])) > 30000 || binding == null || (string)command["url_hash"] != (string)binding["url_hash"]) throw new ControlFailure(403, "sdk_control_request_invalid");
        string action = (string)command["action"];
        if (action != "get" && action != "light" && action != "alarm" && action != "settings") throw new ControlFailure(400, "sdk_control_request_invalid");
        if (action == "settings") ValidateSettingsCommand(command);
        if (action != "get" && !(command["enabled"] is bool)) throw new ControlFailure(400, "sdk_control_request_invalid");
        if (action == "alarm" && Convert.ToBoolean(command["enabled"]) && !new List<int>{5,10,30}.Contains(Convert.ToInt32(command["duration_seconds"]))) throw new ControlFailure(400, "sdk_control_request_invalid");
        return command;
    }
    static bool OwnLease(string lease, string request)
    {
        try { return (string)Read(lease)["request"] == request; } catch { return false; }
    }
    static void ReleaseLease(string lease, string request)
    {
        if (lease != null && OwnLease(lease, request)) try { File.Delete(lease); } catch (IOException) {}
    }
    static void RunControl(string configuration, Dictionary<string, object> config, string[] args)
    {
        Guid request;
        if (args.Length != 4 || !Guid.TryParseExact(args[3], "D", out request)) throw new Exception("sdk_control_request_invalid");
        string directory = Path.Combine(ControlRoot, request.ToString("D")), lease = null;
        TendaNative.ThingClient client = null; bool alarmMayBeActive = false, leaseOwned = false;
        try {
            var command = ControlCommand(directory); int id = Convert.ToInt32(command["camera_id"]);
            string action = (string)command["action"]; bool enabled = action != "get" && Convert.ToBoolean(command["enabled"]);
            if (!ParentAlive() || File.Exists(Path.Combine(directory, "stop"))) throw new ControlFailure(409, "sdk_control_cancelled");
            TendaNative.Initialize(Path.GetDirectoryName(typeof(TalkAgent).Assembly.Location), config, delegate { return Authorize(config); });
            client = new TendaNative.ThingClient(deviceIds[id]); var state = ControlState(client);
            if (!ParentAlive() || File.Exists(Path.Combine(directory, "stop"))) throw new ControlFailure(409, "sdk_control_cancelled");
            if (action == "get") { Write(Path.Combine(directory, "result.json"), new { ok = true, state = state }); return; }
            if (action == "settings") { ApplySettings(client, command, directory, id); return; }
            if ((action == "alarm" && !state.alarm_supported) || (action == "light" && !state.light_supported)) throw new ControlFailure(422, "sdk_control_unsupported");
            if (action == "light") {
                client.Light(enabled); state = ConfirmControl(client, action, enabled);
                Write(Path.Combine(directory, "result.json"), new { ok = true, acknowledged = true, confirmed = state.light_enabled == enabled, state = state }); return;
            }
            lease = Path.Combine(ControlRoot, "alarm-" + id + ".json");
            if (!enabled) {
                client.Alarm(false); state = ControlState(client);
                // A stop command also cancels an alarm surviving a backend restart.
                try { var old = Read(lease); Guid previous; if (Guid.TryParseExact((string)old["request"], "D", out previous)) File.WriteAllText(Path.Combine(ControlRoot, previous.ToString("D"), "stop"), ""); } catch (IOException) {}
                try { File.Delete(lease); } catch (IOException) {}
                Write(Path.Combine(directory, "result.json"), new { ok = true, acknowledged = true, confirmed = false, state = state }); return;
            }
            if (state.talking) throw new ControlFailure(409, "sdk_control_camera_talking");
            int seconds = Convert.ToInt32(command["duration_seconds"]); long ends = Now + seconds * 1000;
            try {
                using (var file = new FileStream(lease, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (var writer = new StreamWriter(file, utf8)) writer.Write(json.Serialize(new { camera_id = id, url_hash = command["url_hash"], request = request.ToString("D"), agent_instance = instance, created_at = Now, ends_at = ends }));
                leaseOwned = true;
            } catch (IOException) { throw new ControlFailure(409, "sdk_control_alarm_busy"); }
            alarmMayBeActive = true; client.Alarm(true); state = ControlState(client);
            Write(Path.Combine(directory, "result.json"), new { ok = true, acknowledged = true, confirmed = false, state = state, ends_at = ends });
            while (Now < ends && ParentAlive() && OwnLease(lease, request.ToString("D")) && !File.Exists(Path.Combine(directory, "stop")) && !File.Exists(Path.Combine(Path.GetDirectoryName(configuration), "stop-agent"))) TendaNative.Pump(50);
            client.Alarm(false); state = ControlState(client);
            alarmMayBeActive = false;
            Write(Path.Combine(directory, "finished.json"), new { ok = true, acknowledged = true, confirmed = false, state = state });
        }
        catch (Exception error) {
            bool stopped = !alarmMayBeActive;
            if (alarmMayBeActive && client != null) try { client.Alarm(false); stopped = true; var state = ControlState(client); Write(Path.Combine(directory, "finished.json"), new { ok = true, acknowledged = true, confirmed = false, state = state }); } catch {}
            if (!File.Exists(Path.Combine(directory, "result.json"))) Write(Path.Combine(directory, "result.json"), new { ok = false, status = error is ControlFailure ? ((ControlFailure)error).Status : 503, error = error is ControlFailure ? error.Message : "sdk_control_unavailable" });
            if (!stopped) Write(Path.Combine(directory, "finished.json"), new { ok = false, status = 502, error = "sdk_control_stop_unconfirmed" });
            alarmMayBeActive = !stopped;
        }
        finally { if (leaseOwned && !alarmMayBeActive) ReleaseLease(lease, request.ToString("D")); }
    }

    static void ScanControls(string configuration, Dictionary<string, WorkerProcess> workers, bool ready)
    {
        Directory.CreateDirectory(ControlRoot); int count = 0, scanned = 0;
        foreach (var worker in workers.Values) if (worker.Control) count++;
        foreach (string directory in Directory.GetDirectories(ControlRoot)) {
            if (++scanned > 128) break;
            Guid request; string name = Path.GetFileName(directory), key = "control:" + name;
            if (!Guid.TryParseExact(name, "D", out request) || workers.ContainsKey(key) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
            if (File.Exists(Path.Combine(directory, "result.json"))) {
                if (Now - new DateTimeOffset(Directory.GetLastWriteTimeUtc(directory)).ToUnixTimeMilliseconds() > 60000) try { Directory.Delete(directory, true); } catch (IOException) {}
                continue;
            }
            if (!File.Exists(Path.Combine(directory, "request.json"))) continue;
            try {
                ControlCommand(directory);
                if (!ready || count >= 4) throw new ControlFailure(503, "sdk_control_busy");
                workers.Add(key, new WorkerProcess { Process = Launch(configuration, "--control " + instance + " " + name), Directory = directory, Started = Now, Control = true }); count++;
            } catch { Write(Path.Combine(directory, "result.json"), new { ok = false, status = 503, error = "sdk_control_unavailable" }); }
        }
    }
    static readonly Dictionary<int, long> recoveryAfter = new Dictionary<int, long>();
    static void RecoverControls(Dictionary<string, WorkerProcess> workers)
    {
        foreach (var binding in bindings) {
            int id = Convert.ToInt32(binding["id"]); string lease = Path.Combine(ControlRoot, "alarm-" + id + ".json");
            if (!File.Exists(lease) || (recoveryAfter.ContainsKey(id) && Now < recoveryAfter[id])) continue;
            try {
                var value = Read(lease); Guid request;
                if (!Guid.TryParseExact((string)value["request"], "D", out request) || Convert.ToInt32(value["camera_id"]) != id || (string)value["url_hash"] != (string)binding["url_hash"]) continue;
                if (workers.ContainsKey("control:" + request.ToString("D"))) continue;
                // Stop an orphaned timed alarm before accepting another start.
                string next = Guid.NewGuid().ToString("D"), directory = Path.Combine(ControlRoot, next); Directory.CreateDirectory(directory);
                Write(Path.Combine(directory, "request.json"), new { version = 1, agent_instance = instance, created_at = Now, camera_id = id, url_hash = binding["url_hash"], action = "alarm", enabled = false });
                recoveryAfter[id] = Now + 15000;
            } catch (IOException) {} catch (ArgumentException) {} catch (KeyNotFoundException) {}
        }
    }
}
