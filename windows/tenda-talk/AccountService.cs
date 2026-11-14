using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

public static partial class TalkAgent
{
    static TendaAccountCrypto accountCrypto;
    static Dictionary<string, object> accountConfig;
    static readonly object accountLock = new object();
    static Thread accountThread;
    static volatile bool accountChanged, accountManual;
    static string accountError = "", accountState = "unavailable";
    static long accountRetryAt, accountPublished, accountLastLogin;
    static int accountFailures;
    static bool accountNeedsLogin;
    static Dictionary<string, object> AccountRead(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new TendaAccountException("account_request_invalid");
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            if (file.Length > 16384) throw new TendaAccountException("account_request_invalid");
            using (var reader = new StreamReader(file, utf8)) return TendaAccountCloud.Serializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
    }
    static void AccountWrite(string path, object value)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, TendaAccountCloud.Serializer().Serialize(value), utf8);
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    static Dictionary<string, object> AccountLoad(string path)
    {
        byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), utf8.GetBytes("CameraStation.TendaTalk.v1"), DataProtectionScope.LocalMachine);
        try { return TendaAccountCloud.Serializer().Deserialize<Dictionary<string, object>>(utf8.GetString(bytes)); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    static string AccountHash(string path)
    {
        using (var sha = SHA256.Create()) return Convert.ToBase64String(sha.ComputeHash(File.ReadAllBytes(path)));
    }
    static void AccountSave(string path, Dictionary<string, object> value, string previousHash)
    {
        byte[] bytes = utf8.GetBytes(TendaAccountCloud.Serializer().Serialize(value));
        string temporary = path + ".account.tmp";
        try
        {
            File.WriteAllBytes(temporary, ProtectedData.Protect(bytes, utf8.GetBytes("CameraStation.TendaTalk.v1"), DataProtectionScope.LocalMachine));
            if (AccountHash(path) != previousHash) throw new TendaAccountException("account_configuration_changed");
            File.Replace(temporary, path, null);
        }
        finally { Array.Clear(bytes, 0, bytes.Length); if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static bool AccountAutomatic(Dictionary<string, object> value)
    {
        object enabled; return value.TryGetValue("accountAutoRefresh", out enabled) && enabled is bool && (bool)enabled;
    }
    static bool AccountAlive(string directory)
    {
        try
        {
            if (File.Exists(Path.Combine(directory, "stop")) || File.Exists(Path.Combine(Path.GetDirectoryName(typeof(TalkAgent).Assembly.Location), "stop-agent"))) return false;
            var heartbeat = AccountRead(Path.Combine(directory, "heartbeat.json"));
            return (string)heartbeat["instance"] == instance && Math.Abs(Now - Convert.ToInt64(heartbeat["updated_at"])) < 1500;
        }
        catch { return false; }
    }
    static void AccountInitialize(string configuration)
    {
        try
        {
            accountCrypto = new TendaAccountCrypto(Path.Combine(Path.GetDirectoryName(configuration), "account-key.bin"));
            accountConfig = AccountLoad(configuration);
            accountState = AccountAutomatic(accountConfig) ? "connected" : "login_required";
            Directory.CreateDirectory(Path.Combine(root, "account"));
        }
        catch { accountError = "account_configuration"; accountState = "unavailable"; }
    }
    static void AccountRun(string configuration, string directory)
    {
        try
        {
            string originalHash = AccountHash(configuration);
            var original = AccountLoad(configuration);
            var cloud = new TendaAccountCloud(); Dictionary<string, object> updated;
            if (directory == null) updated = cloud.Refresh(original);
            else
            {
                var command = AccountRead(Path.Combine(directory, "command.json"));
                if (Convert.ToInt32(command["version"]) != 1 || (string)command["instance"] != instance || (string)command["kind"] != "login" || Math.Abs(Now - Convert.ToInt64(command["created_at"])) > 30000 || !AccountAlive(directory)) throw new TendaAccountException("account_cancelled");
                string account = TendaAccountCloud.Text(command, "account");
                if (account.Length > 254 || !Regex.IsMatch(account, "^(?:[^\\s@]+@[^\\s@]+\\.[^\\s@]+|[0-9]{6,20})$")) throw new TendaAccountException("account_request_invalid");
                string password = accountCrypto.Decrypt(TendaAccountCloud.Text(command, "kid"), TendaAccountCloud.Text(command, "password_ciphertext"));
                File.Delete(Path.Combine(directory, "command.json"));
                try { updated = cloud.Login(original, account, password, "2" + ((string)accountCrypto.PublicKey["kid"]).Substring(0, 32)); }
                finally { password = null; }
            }
            if (directory != null && !AccountAlive(directory)) throw new TendaAccountException("account_cancelled");
            if (File.Exists(Path.Combine(Path.GetDirectoryName(configuration), "stop-agent"))) throw new TendaAccountException("account_cancelled");
            AccountSave(configuration, updated, originalHash);
            lock (accountLock) { accountConfig = updated; accountState = "connected"; accountError = ""; accountFailures = 0; accountNeedsLogin = false; accountRetryAt = 0; accountChanged = true; }
            if (directory != null) AccountWrite(Path.Combine(directory, "result.json"), new { ok = true });
        }
        catch (Exception error)
        {
            var typed = error as TendaAccountException; string code = typed == null ? "account_unavailable" : typed.Code;
            lock (accountLock)
            {
                accountError = code;
                if (directory == null)
                {
                    accountNeedsLogin = code == "account_rejected" || code == "account_owner_mismatch" || code == "account_token_invalid";
                    accountFailures = Math.Min(5, accountFailures + 1); accountRetryAt = Now + Math.Min(600000, 30000L * (1 << accountFailures));
                }
                accountState = accountNeedsLogin || !AccountAutomatic(accountConfig) ? "login_required" : "retrying";
            }
            if (directory != null) try { AccountWrite(Path.Combine(directory, "result.json"), new { ok = false, error = code }); } catch {}
        }
        finally { accountManual = false; }
    }
    static void AccountTick(string configuration, bool busy, bool sdkReady)
    {
        if (accountThread != null && !accountThread.IsAlive) { accountThread.Join(); accountThread = null; }
        if (accountCrypto != null && accountConfig != null && accountThread == null)
        {
            string selected = null; int scanned = 0;
            foreach (string directory in Directory.GetDirectories(Path.Combine(root, "account")))
            {
                if (++scanned > 64) break;
                Guid id; if (!Guid.TryParseExact(Path.GetFileName(directory), "D", out id) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
                if (File.Exists(Path.Combine(directory, "result.json")) || !File.Exists(Path.Combine(directory, "command.json")))
                {
                    if (Now - new DateTimeOffset(Directory.GetLastWriteTimeUtc(directory)).ToUnixTimeMilliseconds() > 120000) try { Directory.Delete(directory, true); } catch {}
                    continue;
                }
                if (!AccountAlive(directory)) { try { Directory.Delete(directory, true); } catch {} continue; }
                if (busy || Now - accountLastLogin < 30000)
                {
                    AccountWrite(Path.Combine(directory, "result.json"), new { ok = false, error = busy ? "account_busy" : "account_rate_limited" }); continue;
                }
                selected = directory; accountLastLogin = Now; break;
            }
            long expires = 0; try { expires = TendaAccountCloud.Expires(TendaAccountCloud.Text(accountConfig, "accessToken")); } catch {}
            bool refresh = selected == null && AccountAutomatic(accountConfig) && !accountNeedsLogin && Now >= accountRetryAt && expires < Now + 120000;
            if (selected != null || refresh)
            {
                accountManual = selected != null;
                lock (accountLock) { accountState = selected != null ? "signing_in" : "refreshing"; }
                accountThread = new Thread(delegate() { AccountRun(configuration, selected); }); accountThread.IsBackground = true; accountThread.Start();
            }
        }
        if (Now - accountPublished >= 500)
        {
            accountPublished = Now;
            try
            {
                lock (accountLock)
                {
                    long expires = 0; try { expires = TendaAccountCloud.Expires(TendaAccountCloud.Text(accountConfig, "accessToken")); } catch {}
                    AccountWrite(Path.Combine(root, "account-status.json"), new { version = 1, instance = instance, updated_at = Now, state = accountState, account_label = TendaAccountCloud.Text(accountConfig, "accountLabel"), expires_at = expires, auto_refresh = accountConfig != null && AccountAutomatic(accountConfig), sdk_ready = sdkReady, error = accountError, public_key = accountCrypto == null ? null : accountCrypto.PublicKey });
                }
            }
            catch (IOException) {} catch (UnauthorizedAccessException) {}
        }
    }
}
