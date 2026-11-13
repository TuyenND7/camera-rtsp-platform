using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;

// Each call receives a fresh SDK process. This also contains native SDK crashes
// and avoids sharing its legacy capture/P2P state between simultaneous cameras.
public static partial class TalkAgent
{
    static long providerUpdated, parentUpdated;
    sealed class WorkerProcess
    {
        public Process Process;
        public string Directory;
        public long Started, StopRequested;
        public bool Control;
    }
    static bool WorkerExpired(WorkerProcess worker)
    {
        return Now - worker.Started > 70000 && !(worker.Control && ControlLeaseHealthy(worker.Directory));
    }
    static Process Launch(string configuration, string arguments)
    {
        var info = new ProcessStartInfo(typeof(TalkAgent).Assembly.Location, "\"" + configuration + "\" " + arguments);
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.WorkingDirectory = Path.GetDirectoryName(typeof(TalkAgent).Assembly.Location);
        return Process.Start(info);
    }
    static bool ProviderReady()
    {
        try
        {
            var provider = Read(Path.Combine(root, "provider.json"));
            bool valid = (string)provider["instance"] == instance && Convert.ToBoolean(provider["authenticated"]);
            providerUpdated = valid ? Convert.ToInt64(provider["updated_at"]) : 0;
            return valid && Math.Abs(Now - providerUpdated) < 600000;
        }
        // Atomic replacement on the Windows/Docker shared directory can briefly
        // deny a read. Reuse only the last verified record within its original
        // expiry; an explicit revoked generation/account still fails at once.
        catch (IOException) { return providerUpdated > 0 && Math.Abs(Now - providerUpdated) < 600000; }
        catch { return false; }
    }
    static bool ParentAlive()
    {
        try
        {
            var parent = Read(Path.Combine(root, "status.json"));
            bool valid = (string)parent["instance"] == instance && Convert.ToBoolean(parent["authenticated"]);
            parentUpdated = valid ? Convert.ToInt64(parent["updated_at"]) : 0;
            return valid && Math.Abs(Now - parentUpdated) < 3000;
        }
        catch (IOException) { return parentUpdated > 0 && Math.Abs(Now - parentUpdated) < 3000; }
        catch { return false; }
    }
    static void Provider(bool authenticated)
    {
        Write(Path.Combine(root, "provider.json"), new { instance = instance, updated_at = Now, authenticated = authenticated });
    }
    static void RunWorker(string configuration, Dictionary<string, object> config, string[] args)
    {
        bool health = args[1] == "--health"; string directory = null;
        try
        {
            if (!health)
            {
                Guid session;
                if (args[1] != "--voice" || args.Length != 4 || !Guid.TryParseExact(args[3], "D", out session)) throw new Exception("sdk_session_invalid");
                directory = Path.Combine(root, session.ToString("D"));
                if (!ParentAlive() || !Command(directory, Read(Path.Combine(directory, "start.json")))) throw new Exception("sdk_session_invalid");
            }
            TendaNative.Initialize(Path.GetDirectoryName(typeof(TalkAgent).Assembly.Location), config, delegate { return Authorize(config); });
            if (health) { Provider(TendaNative.Authenticated); return; }
            if (!ParentAlive()) throw new Exception("sdk_session_invalid");
            Open(directory, config);
            while (clients.Count > 0)
            {
                bool active = false;
                foreach (var client in clients.Values) if (client.Job != null) active = true;
                if (!active) break;
                bool authenticated = TendaNative.Authenticated, parentAlive = ParentAlive();
                if (!authenticated || !parentAlive || File.Exists(Path.Combine(Path.GetDirectoryName(configuration), "stop-agent")))
                {
                    foreach (var client in clients.Values) client.Close();
                    State(directory, "closed", 0, !authenticated ? 50301 : !parentAlive ? 50302 : 0); break;
                }
                Tick(config, false); TendaNative.Pump(40);
            }
        }
        catch
        {
            if (health) Provider(false); else if (directory != null) State(directory, "error", 0, 502);
            throw;
        }
        finally
        {
            foreach (var client in clients.Values) try { client.Close(); } catch {}
            if (clients.Count > 0) TendaNative.Pump(300);
        }
    }
    static void RunBroker(string configuration)
    {
        var workers = new Dictionary<string, WorkerProcess>(); Process health = null; long checkedAt = 0, published = 0;
        Publish(false);
        try
        {
            while (!File.Exists(Path.Combine(Path.GetDirectoryName(configuration), "stop-agent")))
            {
                if (health != null && health.HasExited) { health.Dispose(); health = null; }
                if (health == null && Now - checkedAt > 300000)
                {
                    health = Launch(configuration, "--health " + instance); checkedAt = Now;
                }
                if (health != null && Now - checkedAt > 35000) { try { health.Kill(); } catch {} health.Dispose(); health = null; }
                bool ready = ProviderReady();
                if (Now - published >= 250) { Publish(ready); published = Now; }
                var finished = new List<string>();
                foreach (var item in workers)
                {
                    var worker = item.Value;
                    if (!worker.Process.HasExited && (WorkerExpired(worker) || !ready))
                    {
                        try { File.WriteAllText(Path.Combine(worker.Directory, "stop"), ""); } catch {}
                        if (worker.StopRequested == 0) worker.StopRequested = Now;
                        if (Now - worker.StopRequested > 2000) try { worker.Process.Kill(); } catch {}
                    }
                    if (worker.Process.HasExited)
                    {
                        if (worker.Control) {
                            if (!File.Exists(Path.Combine(worker.Directory, "result.json"))) Write(Path.Combine(worker.Directory, "result.json"), new { ok = false, status = 503, error = "sdk_control_worker_stopped" });
                            worker.Process.Dispose(); finished.Add(item.Key); continue;
                        }
                        try
                        {
                            var state = Read(Path.Combine(worker.Directory, "state.json"));
                            if ((string)state["state"] != "closed" && (string)state["state"] != "error") State(worker.Directory, "error", Convert.ToInt64(state["consumed"]), 502);
                        }
                        catch { State(worker.Directory, "error", 0, 502); }
                        worker.Process.Dispose(); finished.Add(item.Key);
                    }
                }
                foreach (string session in finished) workers.Remove(session);
                ScanControls(configuration, workers, ready);
                if (ready) RecoverControls(workers);
                int scanned = 0;
                foreach (string directory in Directory.GetDirectories(root))
                {
                    if (++scanned > 128) break;
                    Guid session; string name = Path.GetFileName(directory);
                    if (!Guid.TryParseExact(name, "D", out session) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 || workers.ContainsKey(name)) continue;
                    if (File.Exists(Path.Combine(directory, "state.json")))
                    {
                        if (Now - new DateTimeOffset(Directory.GetLastWriteTimeUtc(directory)).ToUnixTimeMilliseconds() > 60000) try { Directory.Delete(directory, true); } catch (IOException) {}
                        continue;
                    }
                    if (!File.Exists(Path.Combine(directory, "start.json"))) continue;
                    try
                    {
                        if (!ready || workers.Count >= 16 || !Command(directory, Read(Path.Combine(directory, "start.json")))) { State(directory, "error", 0, 503); continue; }
                        State(directory, "connecting", 0, 0);
                        workers.Add(name, new WorkerProcess { Process = Launch(configuration, "--voice " + instance + " " + name), Directory = directory, Started = Now });
                    }
                    catch { State(directory, "error", 0, 502); }
                }
                Thread.Sleep(40);
            }
        }
        finally
        {
            Publish(false);
            foreach (var worker in workers.Values) try { File.WriteAllText(Path.Combine(worker.Directory, "stop"), ""); } catch {}
            Thread.Sleep(500);
            long deadline = Now + 10000;
            while (Now < deadline) {
                bool activeControl = false; foreach (var worker in workers.Values) if (worker.Control && !worker.Process.HasExited) activeControl = true;
                if (!activeControl) break; Thread.Sleep(100);
            }
            foreach (var worker in workers.Values) { try { if (!worker.Process.HasExited) worker.Process.Kill(); } catch {} worker.Process.Dispose(); }
            if (health != null) { try { if (!health.HasExited) health.Kill(); } catch {} health.Dispose(); }
        }
    }
}
