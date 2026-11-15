using System;
using System.IO;
using System.Collections.Generic;
using System.Text.RegularExpressions;

public static partial class TalkAgent
{
    static readonly Dictionary<int, long> bindingAddressRead = new Dictionary<int, long>();
    static string BindingHash(Dictionary<string, object> value, string key)
    {
        object raw;
        return value.TryGetValue(key, out raw) && raw is string && Regex.IsMatch((string)raw, "^[a-f0-9]{64}$") ? (string)raw : null;
    }
    static bool ApplyBindingAddress(Dictionary<string, object> binding, Dictionary<string, object> address)
    {
        object version;
        if (address.Count != 5 || !address.TryGetValue("version", out version) || !(version is int || version is long) || Convert.ToInt32(version) != 1) return false;
        string original = BindingHash(binding, "original_url_hash"), serial = BindingHash(binding, "serial_hash"), target = BindingHash(binding, "target_hash"), next = BindingHash(address, "url_hash");
        if (original == null || serial == null || target == null || next == null || BindingHash(address, "original_url_hash") != original || BindingHash(address, "serial_hash") != serial || BindingHash(address, "target_hash") != target) return false;
        binding["url_hash"] = next;
        return true;
    }
    static void RefreshBindingAddresses()
    {
        foreach (var binding in bindings) {
            string original = BindingHash(binding, "original_url_hash");
            if (original == null) continue;
            int id = Convert.ToInt32(binding["id"]);
            string directory = Path.Combine(root, "bindings"), file = Path.Combine(directory, id + ".json");
            try {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || !ApplyBindingAddress(binding, Read(file))) { binding["url_hash"] = original; bindingAddressRead.Remove(id); }
                else bindingAddressRead[id] = Now;
            }
            catch (IOException) { long last; if (!bindingAddressRead.TryGetValue(id, out last) || Now - last >= 3000) binding["url_hash"] = original; }
            catch { binding["url_hash"] = original; bindingAddressRead.Remove(id); }
        }
    }
}
