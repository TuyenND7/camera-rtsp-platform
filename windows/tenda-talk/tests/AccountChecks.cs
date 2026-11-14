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
        public int Checks, Logins;
        public bool RejectCheck;
        public int CheckFailure = 100421;
        public string FoundPhone;
        public string Mode = "ENCRYPT_PHONE", SeMode = "", Phone = "84987654321", Email = "canonical@example.com";
        public Dictionary<string, object> CheckBody;
        public Dictionary<string, object> Body;
        public Dictionary<string, object> Send(Dictionary<string, object> config, string method, string path, Dictionary<string, object> body)
        {
            if (Reject) return new Dictionary<string, object> { { "code", 100413 } };
            if (path == TendaAccountCloud.CheckPath)
            {
                Checks++; CheckBody = body;
                if (RejectCheck || (FoundPhone != null && TendaAccountCloud.Text(body, "phone") != FoundPhone)) return new Dictionary<string, object> { { "code", CheckFailure } };
                return new Dictionary<string, object> { { "code", 0 }, { "data", new Dictionary<string, object> { { "encrypt_mode", Mode }, { "se_encrypt_mode", SeMode }, { "phone", Phone }, { "email", Email }, { "country_code", "VN" }, { "phone_code", "+84" } } } };
            }
            if (path == TendaAccountCloud.CodePath) { Codes++; return new Dictionary<string, object> { { "code", 0 }, { "data", new Dictionary<string, object> { { "auth_code", "fixture-authorization-code" } } } }; }
            if (path == TendaAccountCloud.LoginPath) { Check(Checks > Logins, "login omitted account preflight"); Logins++; }
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
        Check(TendaAccountCloud.Text(transport.CheckBody, "phone") == "0123456789" && !transport.CheckBody.ContainsKey("password"), "account preflight protocol");
        Check(TendaAccountCloud.Text(transport.Body, "password") == "6fb5684ba05970be4c5ac3ce4d17946c" && TendaAccountCloud.Text(transport.Body, "se_password") == "6fb5684ba05970be4c5ac3ce4d17946c" && transport.Codes == 1, "canonical phone password digest");
        Check(!TendaAccountCloud.Serializer().Serialize(transport.Body).Contains("fixture-password"), "plaintext password reached login endpoint");
        transport.FoundPhone = "987654321";
        foreach (string input in new string[] { "0987654321", "84987654321", "+84987654321", "+84 (0)98 765-4321" })
        {
            cloud.Login(original, input, "fixture-password", "fixture-server-terminal");
            Check(TendaAccountCloud.Text(transport.Body, "phone") == "987654321", "Vietnam phone form did not reach canonical login");
        }
        int attempts = transport.Checks, existingLogins = transport.Logins;
        transport.CheckFailure = 100422;
        try { cloud.Login(original, "0987654321", "fixture-password", "fixture-server-terminal"); throw new Exception("provider error ignored"); }
        catch (TendaAccountException error) { Check(error.ProviderCode == 100422, "provider failure changed"); }
        Check(transport.Checks == attempts + 1 && transport.Logins == existingLogins, "identifier retried after a non-not-found failure");
        transport.CheckFailure = 100421; transport.FoundPhone = "0987654321"; attempts = transport.Checks;
        cloud.Login(original, "0987654321", "fixture-password", "fixture-server-terminal");
        Check(transport.Checks == attempts + 1 && TendaAccountCloud.Text(transport.Body, "phone") == "0987654321", "legacy exact phone identifier was changed");
        attempts = transport.Checks;
        Rejected(delegate { cloud.Login(original, "+86987654321", "fixture-password", "fixture-server-terminal"); }, "account_phone_country");
        Check(transport.Checks == attempts, "different country was looked up using the wrong country context");
        transport.FoundPhone = null;
        transport.Mode = "ENCRYPT_EMAIL";
        cloud.Login(original, "0123456789", "fixture-password", "fixture-server-terminal");
        Check(TendaAccountCloud.Text(transport.Body, "password") == "1aa03f3b7f1ddacb234204361e9c7d10", "linked email password digest");
        transport.Mode = ""; transport.SeMode = "ENCRYPT_EMAIL";
        cloud.Login(original, "0123456789", "fixture-password", "fixture-server-terminal");
        Check(TendaAccountCloud.Text(transport.Body, "password") == "1aa03f3b7f1ddacb234204361e9c7d10", "security email password digest");
        transport.SeMode = "";
        cloud.Login(original, "a@example.com", "fixture-password", "fixture-server-terminal");
        Check(TendaAccountCloud.Text(transport.Body, "password") == "6fb5684ba05970be4c5ac3ce4d17946c", "legacy canonical phone fallback");
        transport.Phone = "";
        cloud.Login(original, "a@example.com", "fixture-password", "fixture-server-terminal");
        Check(TendaAccountCloud.Text(transport.Body, "password") == "1aa03f3b7f1ddacb234204361e9c7d10", "legacy canonical email fallback");
        Check(TendaAccountCloud.PasswordDigest("a@example.com", "ab c") == "d1a2cda9b70304aadebeffe3ed88a2a0", "aligned password digest");
        Check(TendaAccountCloud.PasswordDigest("ng\u01b0\u1eddi@example.com", "m\u1eadtkh\u1ea9u") == "e36ac4fe6db75d9f646eba8e6c6e83d4", "UTF8 password digest and padding");
        int loginCount = transport.Logins; transport.RejectCheck = true;
        try { cloud.Login(original, "a@example.com", "fixture-password", "fixture-server-terminal"); throw new Exception("check rejection ignored"); }
        catch (TendaAccountException error) { Check(error.ProviderCode == 100421 && error.Stage == "check", "safe provider diagnostics lost"); }
        Check(transport.Logins == loginCount, "password sent after rejected preflight"); transport.RejectCheck = false;
        transport.Mode = "ENCRYPT_UNKNOWN";
        Rejected(delegate { cloud.Login(original, "a@example.com", "fixture-password", "fixture-server-terminal"); }, "account_password_mode");
        Check(transport.Logins == loginCount, "password sent with unknown mode"); transport.Mode = "ENCRYPT_EMAIL";
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
        return "PASS: phone 0/84/+84 formatting, exact legacy identifiers, bounded not-found fallback, account preflight and digests, UTF8, safe diagnostics, ownership, refresh, OAEP-SHA256 and DPAPI";
    }
}
