using System;
using System.IO;
using System.Net;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public sealed class TendaAccountException : Exception
{
    public readonly string Code;
    public readonly int ProviderCode;
    public string Stage;
    public TendaAccountException(string code, int providerCode = 0) : base(code) { Code = code; ProviderCode = providerCode; }
}

public interface ITendaAccountTransport
{
    Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body);
}

public sealed class TendaAccountHttp : ITendaAccountTransport
{
    static Dictionary<string, object> ReadResponse(HttpWebResponse response)
    {
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            var buffer = new char[65537]; int size = 0, count;
            while (size < buffer.Length && (count = reader.Read(buffer, size, buffer.Length - size)) > 0) size += count;
            if (size >= buffer.Length) throw new TendaAccountException("account_response_invalid");
            return TendaAccountCloud.Serializer().Deserialize<Dictionary<string, object>>(new string(buffer, 0, size));
        }
    }
    public Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body)
    {
        string region = TendaAccountCloud.Text(config, "region");
        if (!new List<string> { "sa", "cn", "eu", "us" }.Contains(region)) throw new TendaAccountException("account_configuration");
        if (path != TendaAccountCloud.CheckPath && path != TendaAccountCloud.LoginPath && path != TendaAccountCloud.RefreshPath && path != TendaAccountCloud.CodePath) throw new TendaAccountException("account_configuration");
        var headers = config["cloudHeaders"] as Dictionary<string, object>;
        if (headers == null) throw new TendaAccountException("account_configuration");
        var request = (HttpWebRequest)WebRequest.Create("https://" + region + "-cloud.tenda.com.cn" + path);
        request.Method = method; request.Timeout = 10000; request.ReadWriteTimeout = 10000; request.AllowAutoRedirect = false;
        request.ContentType = "application/json"; request.Proxy = null;
        foreach (string key in new string[] { "Terminal", "App-Id", "Project-Id", "AppSource", "terminal-os", "AppVersion", "td-lang", "Provider" })
            if (headers.ContainsKey(key)) request.Headers[key] = (string)headers[key];
        string stamp = (TalkAgent.Now / 1000 - 10).ToString(); request.Headers["Timestamp"] = stamp;
        using (var md5 = MD5.Create()) request.Headers["Sig"] = BitConverter.ToString(md5.ComputeHash(Encoding.UTF8.GetBytes(TendaAccountCloud.Text(headers, "Terminal") + stamp + TendaAccountCloud.Text(config, "cloudSignatureSalt")))).Replace("-", "").ToLowerInvariant();
        string token = TendaAccountCloud.Text(config, "accessToken");
        // A fresh sign-in must not carry the previous (possibly expired) session
        // or a token bound to another terminal. Auth-code and refresh need it.
        if ((path == TendaAccountCloud.CodePath || path == TendaAccountCloud.RefreshPath) && !string.IsNullOrEmpty(token)) request.Headers["Authorization"] = "Bearer " + token;
        try
        {
            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(TendaAccountCloud.Serializer().Serialize(body));
                try { request.ContentLength = bytes.Length; using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length); }
                finally { Array.Clear(bytes, 0, bytes.Length); }
            }
            using (var response = (HttpWebResponse)request.GetResponse())
                return ReadResponse(response);
        }
        catch (WebException error)
        {
            var response = error.Response as HttpWebResponse;
            if (response != null)
            {
                int code = (int)response.StatusCode, provider = 0;
                try { var data = ReadResponse(response); if (data != null && data.ContainsKey("code")) provider = Convert.ToInt32(data["code"]); } catch {} finally { response.Dispose(); }
                if (code == 429) throw new TendaAccountException("account_rate_limited");
                if (code >= 400 && code < 500 && provider > 0) throw new TendaAccountException("account_rejected", provider);
                if (code == 401 || code == 403) throw new TendaAccountException("account_rejected");
            }
            throw new TendaAccountException("account_network");
        }
    }
}

public sealed class TendaAccountCloud
{
    public const string CheckPath = "/td/td-user-api/internal/index/login/check/v2";
    public const string LoginPath = "/td/td-user-api/internal/login/password/v2";
    public const string RefreshPath = "/td/td-user-api/internal/index/refresh/v2";
    public const string CodePath = "/td/td-user-api/internal/user/get/authCode/v1";
    readonly ITendaAccountTransport transport;
    public TendaAccountCloud() : this(new TendaAccountHttp()) {}
    public TendaAccountCloud(ITendaAccountTransport value) { transport = value; }
    public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 16 }; }
    public static string Text(Dictionary<string, object> value, string key) { object result; return value != null && value.TryGetValue(key, out result) && result is string ? (string)result : ""; }
    public static Dictionary<string, object> Claims(string token)
    {
        if (token == null || token.Length > 8192 || !Regex.IsMatch(token, "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")) throw new TendaAccountException("account_token_invalid");
        try
        {
            string part = token.Split('.')[1].Replace('-', '+').Replace('_', '/'); part = part.PadRight(part.Length + (4 - part.Length % 4) % 4, '=');
            return Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(part)));
        }
        catch { throw new TendaAccountException("account_token_invalid"); }
    }
    public static long Expires(string token)
    {
        try { return checked(Convert.ToInt64(Claims(token)["exp"]) * 1000); }
        catch { throw new TendaAccountException("account_token_invalid"); }
    }
    static Dictionary<string, object> Data(Dictionary<string, object> response)
    {
        if (response == null || !response.ContainsKey("code")) throw new TendaAccountException("account_response_invalid");
        int code = Convert.ToInt32(response["code"]);
        if (code != 0) throw new TendaAccountException("account_rejected", code);
        object data; if (!response.TryGetValue("data", out data) || !(data is Dictionary<string, object>)) throw new TendaAccountException("account_response_invalid");
        return (Dictionary<string, object>)data;
    }
    Dictionary<string, object> Request(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body, string stage)
    {
        try { return Data(transport.Send(config, method, path, body)); }
        catch (TendaAccountException error) { error.Stage = stage; throw; }
    }
    public string AuthorizationCode(Dictionary<string, object> config)
    {
        var data = Request(config, "GET", CodePath, null, "authorization"); string code = Text(data, "auth_code");
        if (code.Length == 0 && data.ContainsKey("security_user")) code = Text(data["security_user"] as Dictionary<string, object>, "auth_code");
        if (code.Length == 0 || code.Length > 4096) throw new TendaAccountException("account_response_invalid");
        return code;
    }
    // TDSEE Utils.encryptAccountPassword: zero-pad UTF-8 password to a multiple
    // of four, append SHA1(canonical account), then MD5 the bytes five times.
    // The canonical account comes from login/check; it can differ from the
    // identifier typed by a user who linked both a phone and an email.
    public static string PasswordDigest(string account, string password)
    {
        byte[] secret = Encoding.UTF8.GetBytes(password), salt = null, digest = null;
        try
        {
            using (var sha = SHA1.Create()) salt = sha.ComputeHash(Encoding.UTF8.GetBytes(account));
            int length = (secret.Length + 3) / 4 * 4;
            digest = new byte[length + salt.Length]; Array.Copy(secret, digest, secret.Length); Array.Copy(salt, 0, digest, length, salt.Length);
            using (var md5 = MD5.Create())
            {
                for (int n = 0; n < 5; n++) { byte[] previous = digest; digest = md5.ComputeHash(previous); Array.Clear(previous, 0, previous.Length); }
            }
            return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
        }
        finally { Array.Clear(secret, 0, secret.Length); if (salt != null) Array.Clear(salt, 0, salt.Length); if (digest != null) Array.Clear(digest, 0, digest.Length); }
    }
    static string PasswordAccount(Dictionary<string, object> data)
    {
        string mode = Text(data, "encrypt_mode"); if (mode.Length == 0) mode = Text(data, "se_encrypt_mode");
        if (mode.Length > 0 && mode != "ENCRYPT_PHONE" && mode != "ENCRYPT_EMAIL") throw new TendaAccountException("account_password_mode");
        string value = mode == "ENCRYPT_EMAIL" ? Text(data, "email") : Text(data, "phone");
        if (mode.Length == 0 && value.Length == 0) value = Text(data, "email");
        if (value.Length == 0 || value.Length > 254) throw new TendaAccountException("account_response_invalid");
        return value;
    }
    public static string NormalizeIdentifier(string account)
    {
        if (account == null || account.Length > 254) throw new TendaAccountException("account_request_invalid");
        account = account.Trim();
        if (account.Contains("@"))
        {
            if (!Regex.IsMatch(account, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) throw new TendaAccountException("account_request_invalid");
            return account;
        }
        account = Regex.Replace(account, "[\\s().-]", "");
        if (!Regex.IsMatch(account, "^\\+?[0-9]{6,20}$")) throw new TendaAccountException("account_request_invalid");
        return account;
    }
    public static List<string> IdentifierCandidates(string account, string phoneCode)
    {
        account = NormalizeIdentifier(account);
        if (account.Contains("@")) return new List<string> { account };
        string code = phoneCode.TrimStart('+');
        var values = new List<string>();
        if (account.StartsWith("+"))
        {
            if (code.Length == 0 || !account.StartsWith("+" + code)) throw new TendaAccountException("account_phone_country");
            account = account.Substring(code.Length + 1);
            if (code == "84" && account.Length == 10 && account.StartsWith("0")) account = account.Substring(1);
            if (!Regex.IsMatch(account, "^[0-9]{6,15}$")) throw new TendaAccountException("account_request_invalid");
            values.Add(account);
            if (code == "84" && account.Length == 9) values.Add("0" + account);
        }
        else
        {
            // Keep an existing exact identifier working. Try the Vietnamese
            // national form only after Tenda says the original does not exist.
            values.Add(account);
            if (code == "84")
            {
                if (account.Length == 10 && account.StartsWith("0")) values.Add(account.Substring(1));
                else if (account.Length == 11 && account.StartsWith("84")) values.Add(account.Substring(2));
            }
        }
        return values;
    }
    Dictionary<string, object> Apply(Dictionary<string, object> original, Dictionary<string, object> candidate, Dictionary<string, object> data)
    {
        string token = Text(data, "access_token"); var previous = Claims(Text(original, "accessToken")); var claims = Claims(token);
        if (Text(previous, "uid").Length == 0 || Text(previous, "project_id").Length == 0 || Text(previous, "uid") != Text(claims, "uid") || Text(previous, "project_id") != Text(claims, "project_id")) throw new TendaAccountException("account_owner_mismatch");
        long expires = Expires(token);
        if (expires < TalkAgent.Now + 60000 || expires > TalkAgent.Now + 180L * 86400000) throw new TendaAccountException("account_token_invalid");
        candidate["accessToken"] = token;
        AuthorizationCode(candidate); // Validate the token with the provider; decoded JWT claims alone are not authentication.
        candidate["accountExpiresAt"] = expires; candidate["accountRefreshedAt"] = TalkAgent.Now; candidate["accountAutoRefresh"] = true;
        return candidate;
    }
    public Dictionary<string, object> Login(Dictionary<string, object> original, string account, string password, string terminal)
    {
        var candidate = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(original));
        var headers = (Dictionary<string, object>)candidate["cloudHeaders"]; headers["Terminal"] = terminal;
        var claims = Claims(Text(original, "accessToken")); string country = Text(claims, "country_code"), phoneCode = Text(claims, "phone_code");
        if (country.Length == 0) country = "VN"; if (phoneCode.Length == 0) phoneCode = "+84";
        var candidates = IdentifierCandidates(account, phoneCode);
        Dictionary<string, object> checkedAccount = null; string loginAccount = candidates[0];
        for (int n = 0; n < candidates.Count; n++)
        {
            loginAccount = candidates[n];
            var identifier = new Dictionary<string, object>(); identifier[loginAccount.Contains("@") ? "email" : "phone"] = loginAccount;
            try { checkedAccount = Request(candidate, "POST", CheckPath, identifier, "check"); break; }
            catch (TendaAccountException error) { if (error.ProviderCode != 100421 || n + 1 == candidates.Count) throw; }
        }
        string encodedPassword = PasswordDigest(PasswordAccount(checkedAccount), password);
        if (Text(checkedAccount, "country_code").Length > 0) country = Text(checkedAccount, "country_code");
        if (Text(checkedAccount, "phone_code").Length > 0) phoneCode = Text(checkedAccount, "phone_code");
        if (country.Length == 0) country = "VN"; if (phoneCode.Length == 0) phoneCode = "84"; if (!phoneCode.StartsWith("+")) phoneCode = "+" + phoneCode;
        var body = new Dictionary<string, object> { { "password", encodedPassword }, { "se_password", encodedPassword }, { "terminal", terminal }, { "push_token", "" }, { "language", "vi" }, { "timezone", "GMT+07:00" }, { "push_OS", "ali" }, { "terminal_os", "Android" }, { "source", Text(headers, "AppSource") }, { "country_code", country }, { "phone_code", phoneCode }, { "app_version", Text(headers, "AppVersion") }, { "phone_model", "Camera Station Windows" } };
        body[loginAccount.Contains("@") ? "email" : "phone"] = loginAccount;
        var data = Request(candidate, "POST", LoginPath, body, "login");
        var result = Apply(original, candidate, data); result["accountLabel"] = Mask(account); result["accountLoginAt"] = TalkAgent.Now;
        return result;
    }
    public Dictionary<string, object> Refresh(Dictionary<string, object> original)
    {
        var candidate = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(original));
        var headers = (Dictionary<string, object>)original["cloudHeaders"];
        var body = new Dictionary<string, object> { { "access_token", Text(original, "accessToken") }, { "terminal", Text(headers, "Terminal") } };
        return Apply(original, candidate, Request(candidate, "POST", RefreshPath, body, "refresh"));
    }
    public static string Mask(string account)
    {
        int at = account.IndexOf('@');
        if (at > 0) return account.Substring(0, 1) + "***" + account.Substring(at);
        return "******" + account.Substring(Math.Max(0, account.Length - 4));
    }
}
