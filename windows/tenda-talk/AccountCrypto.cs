using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;

public sealed class TendaAccountCrypto : IDisposable
{
    readonly RSACng rsa;
    public readonly Dictionary<string, object> PublicKey;
    static readonly byte[] entropy = Encoding.UTF8.GetBytes("CameraStation.TendaAccountKey.v1");
    static string Encode(byte[] value) { return Convert.ToBase64String(value); }
    static byte[] Decode(Dictionary<string, object> value, string key) { return Convert.FromBase64String((string)value[key]); }
    static string Url(byte[] value) { return Encode(value).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    public TendaAccountCrypto(string path)
    {
        rsa = new RSACng(2048);
        if (File.Exists(path))
        {
            byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), entropy, DataProtectionScope.LocalMachine);
            try
            {
                var value = TendaAccountCloud.Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
                rsa.ImportParameters(new RSAParameters { D = Decode(value, "D"), DP = Decode(value, "DP"), DQ = Decode(value, "DQ"), InverseQ = Decode(value, "InverseQ"), P = Decode(value, "P"), Q = Decode(value, "Q"), Modulus = Decode(value, "Modulus"), Exponent = Decode(value, "Exponent") });
            }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        else
        {
            var key = rsa.ExportParameters(true);
            var value = new Dictionary<string, object> { { "D", Encode(key.D) }, { "DP", Encode(key.DP) }, { "DQ", Encode(key.DQ) }, { "InverseQ", Encode(key.InverseQ) }, { "P", Encode(key.P) }, { "Q", Encode(key.Q) }, { "Modulus", Encode(key.Modulus) }, { "Exponent", Encode(key.Exponent) } };
            byte[] bytes = Encoding.UTF8.GetBytes(TendaAccountCloud.Serializer().Serialize(value));
            try { File.WriteAllBytes(path, ProtectedData.Protect(bytes, entropy, DataProtectionScope.LocalMachine)); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        var publicKey = rsa.ExportParameters(false); string n = Url(publicKey.Modulus), e = Url(publicKey.Exponent), kid;
        using (var sha = SHA256.Create()) kid = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(n + "." + e))).Replace("-", "").ToLowerInvariant();
        PublicKey = new Dictionary<string, object> { { "kty", "RSA" }, { "n", n }, { "e", e }, { "kid", kid } };
    }
    public string Decrypt(string kid, string ciphertext)
    {
        if (kid != (string)PublicKey["kid"] || ciphertext.Length > 400) throw new TendaAccountException("account_key_changed");
        byte[] plaintext = null;
        try
        {
            byte[] encrypted = Convert.FromBase64String(ciphertext);
            if (encrypted.Length != 256) throw new TendaAccountException("account_request_invalid");
            plaintext = rsa.Decrypt(encrypted, RSAEncryptionPadding.OaepSHA256);
            if (plaintext.Length < 1 || plaintext.Length > 128) throw new TendaAccountException("account_request_invalid");
            return new UTF8Encoding(false, true).GetString(plaintext);
        }
        catch (TendaAccountException) { throw; }
        catch { throw new TendaAccountException("account_request_invalid"); }
        finally { if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length); }
    }
    public void Dispose() { rsa.Dispose(); }
}
