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
    public TendaAccountException(string code, int providerCode = 0) : base(code) { Code = code; ProviderCode = providerCode; }
}

public interface ITendaAccountTransport
{
    Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body);
}

public sealed class TendaAccountHttp : ITendaAccountTransport
{
    public Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body)
    {
        string region = TendaAccountCloud.Text(config, "region");
        if (!new List<string> { "sa", "cn", "eu", "us" }.Contains(region)) throw new TendaAccountException("account_configuration");
        if (path != TendaAccountCloud.LoginPath && path != TendaAccountCloud.RefreshPath && path != TendaAccountCloud.CodePath) throw new TendaAccountException("account_configuration");
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
        if (!string.IsNullOrEmpty(token)) request.Headers["Authorization"] = "Bearer " + token;
        try
        {
            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(TendaAccountCloud.Serializer().Serialize(body));
                try { request.ContentLength = bytes.Length; using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length); }
                finally { Array.Clear(bytes, 0, bytes.Length); }
            }
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                var buffer = new char[65537]; int size = 0, count;
                while (size < buffer.Length && (count = reader.Read(buffer, size, buffer.Length - size)) > 0) size += count;
                if (size >= buffer.Length) throw new TendaAccountException("account_response_invalid");
                return TendaAccountCloud.Serializer().Deserialize<Dictionary<string, object>>(new string(buffer, 0, size));
            }
        }
        catch (WebException error)
        {
            var response = error.Response as HttpWebResponse;
            if (response != null)
            {
                int code = (int)response.StatusCode; response.Dispose();
                if (code == 401 || code == 403) throw new TendaAccountException("account_rejected");
                if (code == 429) throw new TendaAccountException("account_rate_limited");
            }
            throw new TendaAccountException("account_network");
        }
    }
}

public sealed class TendaAccountCloud
{
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
    public string AuthorizationCode(Dictionary<string, object> config)
    {
        var data = Data(transport.Send(config, "GET", CodePath, null)); string code = Text(data, "auth_code");
        if (code.Length == 0 && data.ContainsKey("security_user")) code = Text(data["security_user"] as Dictionary<string, object>, "auth_code");
        if (code.Length == 0 || code.Length > 4096) throw new TendaAccountException("account_response_invalid");
        return code;
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
        if (country.Length == 0) country = "VN"; if (phoneCode.Length == 0) phoneCode = "84"; if (!phoneCode.StartsWith("+")) phoneCode = "+" + phoneCode;
        var body = new Dictionary<string, object> { { "password", password }, { "se_password", password }, { "terminal", terminal }, { "push_token", "" }, { "language", "vi" }, { "timezone", "GMT+07:00" }, { "push_OS", "ali" }, { "terminal_os", "Android" }, { "source", Text(headers, "AppSource") }, { "country_code", country }, { "phone_code", phoneCode }, { "app_version", Text(headers, "AppVersion") }, { "phone_model", "Camera Station Windows" } };
        body[account.Contains("@") ? "email" : "phone"] = account;
        var data = Data(transport.Send(candidate, "POST", LoginPath, body));
        var result = Apply(original, candidate, data); result["accountLabel"] = Mask(account); result["accountLoginAt"] = TalkAgent.Now;
        return result;
    }
    public Dictionary<string, object> Refresh(Dictionary<string, object> original)
    {
        var candidate = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(original));
        var headers = (Dictionary<string, object>)original["cloudHeaders"];
        var body = new Dictionary<string, object> { { "access_token", Text(original, "accessToken") }, { "terminal", Text(headers, "Terminal") } };
        return Apply(original, candidate, Data(transport.Send(candidate, "POST", RefreshPath, body)));
    }
    public static string Mask(string account)
    {
        int at = account.IndexOf('@');
        if (at > 0) return account.Substring(0, 1) + "***" + account.Substring(at);
        return "******" + account.Substring(Math.Max(0, account.Length - 4));
    }
}
