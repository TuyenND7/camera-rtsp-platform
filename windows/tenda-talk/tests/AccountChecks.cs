using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Collections.Generic;
using System.Security.Cryptography;

public static class AccountChecks
{
    static void Check(bool value, string label) { if (!value) throw new Exception(label); }
    static string Token(string uid, long expires)
    {
        string text = TendaAccountCloud.Serializer().Serialize(new { uid = uid, project_id = "fixture-project", exp = expires / 1000, country_code = "VN", phone_code = "84" });
        return "e30." + Convert.ToBase64String(Encoding.UTF8.GetBytes(text)).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".Zml4dHVyZQ";
    }
    sealed class Transport : ITendaAccountTransport
    {
        public string Uid = "fixture-owner";
        public long Expiry = TalkAgent.Now + 3600000;
        public bool Reject;
        public int Codes;
        public Dictionary<string, object> Body;
        public Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body)
        {
            if (Reject) return new Dictionary<string, object> { { "code", 100413 } };
            if (path == TendaAccountCloud.CodePath) { Codes++; return new Dictionary<string, object> { { "code", 0 }, { "data", new Dictionary<string, object> { { "auth_code", "fixture-authorization-code" } } } }; }
            Body = body;
            return new Dictionary<string, object> { { "code", 0 }, { "data", new Dictionary<string, object> { { "access_token", Token(Uid, Expiry) } } } };
        }
    }
    static void Rejected(Action action, string code)
    {
        try { action(); } catch (TendaAccountException error) { Check(error.Code == code, "wrong error"); return; }
        throw new Exception("unsafe operation accepted");
    }
    public static string Run(string temporary)
    {
        var original = new Dictionary<string, object> { { "accessToken", Token("fixture-owner", TalkAgent.Now - 60000) }, { "region", "sa" }, { "bindings", new object[] { new { id = 2, iotId = "fixture-device" } } }, { "cloudHeaders", new Dictionary<string, object> { { "Terminal", "fixture-old-terminal" }, { "AppSource", "fixture-source" }, { "AppVersion", "fixture-version" } } } };
        var transport = new Transport(); var cloud = new TendaAccountCloud(transport);
        var updated = cloud.Login(original, "0123456789", "fixture-password", "fixture-server-terminal");
        Check(TendaAccountCloud.Text(transport.Body, "phone") == "0123456789" && TendaAccountCloud.Text(transport.Body, "phone_code") == "+84", "phone protocol");
        Check(TendaAccountCloud.Text(transport.Body, "se_password") == "fixture-password" && transport.Codes == 1, "provider authorization verification");
        Check(TendaAccountCloud.Text((Dictionary<string, object>)original["cloudHeaders"], "Terminal") == "fixture-old-terminal", "original mutated");
        Check(TendaAccountCloud.Text(updated, "accountLabel") == "******6789" && !TendaAccountCloud.Serializer().Serialize(updated).Contains("fixture-password"), "password persisted");
        cloud.Refresh(updated); Check(TendaAccountCloud.Text(transport.Body, "access_token") == TendaAccountCloud.Text(updated, "accessToken") && TendaAccountCloud.Text(transport.Body, "terminal") == "fixture-server-terminal", "refresh protocol");
        int previous = transport.Codes; transport.Uid = "other-owner";
        Rejected(delegate { cloud.Login(original, "a@example.com", "fixture-password", "fixture-server-terminal"); }, "account_owner_mismatch");
        Check(transport.Codes == previous, "owner mismatch reached authorization");
        transport.Uid = "fixture-owner"; transport.Expiry = TalkAgent.Now - 60000;
        Rejected(delegate { cloud.Refresh(updated); }, "account_token_invalid");
        transport.Reject = true; Rejected(delegate { cloud.Refresh(updated); }, "account_rejected");
        string keyPath = Path.Combine(temporary, "account-test-key.bin");
        Dictionary<string, object> publicKey;
        using (var crypto = new TendaAccountCrypto(keyPath))
        {
            publicKey = crypto.PublicKey;
            using (var rsa = new RSACng(2048))
            {
                string n = (string)publicKey["n"]; n = n.Replace('-', '+').Replace('_', '/'); n = n.PadRight(n.Length + (4 - n.Length % 4) % 4, '=');
                rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(n), Exponent = new byte[] { 1, 0, 1 } });
                string encrypted = Convert.ToBase64String(rsa.Encrypt(Encoding.UTF8.GetBytes("fixture-password"), RSAEncryptionPadding.OaepSHA256));
                Check(crypto.Decrypt((string)publicKey["kid"], encrypted) == "fixture-password", "OAEP interop");
                Rejected(delegate { crypto.Decrypt("incorrect-key", encrypted); }, "account_key_changed");
            }
        }
        using (var crypto = new TendaAccountCrypto(keyPath)) Check((string)publicKey["kid"] == (string)crypto.PublicKey["kid"], "key persistence");
        var type = typeof(TalkAgent); var flags = BindingFlags.NonPublic | BindingFlags.Static;
        string configPath = Path.Combine(temporary, "account-test-config.bin");
        byte[] bytes = Encoding.UTF8.GetBytes(TendaAccountCloud.Serializer().Serialize(original));
        File.WriteAllBytes(configPath, ProtectedData.Protect(bytes, Encoding.UTF8.GetBytes("CameraStation.TendaTalk.v1"), DataProtectionScope.LocalMachine));
        string hash = (string)type.GetMethod("AccountHash", flags).Invoke(null, new object[] { configPath });
        type.GetMethod("AccountSave", flags).Invoke(null, new object[] { configPath, updated, hash });
        var loaded = (Dictionary<string, object>)type.GetMethod("AccountLoad", flags).Invoke(null, new object[] { configPath });
        Check(TendaAccountCloud.Text(loaded, "accessToken") == TendaAccountCloud.Text(updated, "accessToken") && loaded.ContainsKey("bindings"), "config preservation");
        Check(!Encoding.UTF8.GetString(File.ReadAllBytes(configPath)).Contains(TendaAccountCloud.Text(updated, "accessToken")), "token not encrypted");
        bool rejected = false;
        try { type.GetMethod("AccountSave", flags).Invoke(null, new object[] { configPath, original, hash }); } catch { rejected = true; }
        Check(rejected, "stale config overwritten");
        return "PASS: account ownership, provider validation, login/refresh protocol, password privacy, OAEP-SHA256, DPAPI persistence and stale-write protection";
    }
}
