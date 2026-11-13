using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;

public sealed class DeviceSettingsSnapshot
{
    public SortedDictionary<string, int> values = new SortedDictionary<string, int>(StringComparer.Ordinal);
    public Dictionary<string, int[]> options = new Dictionary<string, int[]>();
    public Dictionary<string, object> info = new Dictionary<string, object>();
    public string revision;
}

public static partial class TalkAgent
{
    sealed class SettingRule
    {
        public string Key, Property, Member;
        public int[] Options;
        public SettingRule(string key, string property, string member, params int[] options) { Key = key; Property = property; Member = member; Options = options; }
    }
    // Values verified against TDSEE's camera object model and its setting screens.
    // Wi-Fi, account, firmware upgrade, reset and card formatting are never accepted here.
    static readonly SettingRule[] settingRules = {
        new SettingRule("night_vision", "stNightVisionMode", "enFillLightMode", 0, 2, 3),
        new SettingRule("infrared", "DayNightMode", null, 0, 1, 2),
        new SettingRule("image_flip", "ImageFlipState", null, 0, 1),
        new SettingRule("indicator", "StatusLightSwitch", null, 0, 1),
        new SettingRule("anti_flicker", "PowerLineFrequency", null, 50, 60),
        new SettingRule("privacy", "OneClickMasking", null, 0, 1),
        new SettingRule("motion_detection", "AlarmSwitch", null, 0, 1),
        new SettingRule("motion_sensitivity", "MotionDetectSensitivity", null, 1, 2, 3),
        new SettingRule("tdsee_notifications", "AlarmPush", null, 0, 1),
        new SettingRule("alarm_sound", "AudibleAlarm", "AlarmSwitch", 0, 1),
        new SettingRule("alarm_light", "AudibleAlarm", "LightSwitch", 0, 1),
        new SettingRule("sd_recording", "StorageRecordMode", null, 0, 1, 2),
        new SettingRule("intercom", "VoiceIntercomMode", null, 1, 2),
        new SettingRule("microphone_volume", "DeviceInputVolume", null, VolumeOptions()),
        new SettingRule("speaker_volume", "DeviceOutputVolume", null, VolumeOptions())
    };
    static int[] VolumeOptions() { var result = new int[101]; for (int i = 0; i <= 100; i++) result[i] = i; return result; }
    static int? SettingInteger(object value)
    {
        if (!(value is int) && !(value is long)) return null;
        long number = Convert.ToInt64(value); return number >= int.MinValue && number <= int.MaxValue ? (int?)number : null;
    }
    static DeviceSettingsSnapshot SettingsFromProperties(Dictionary<string, object> properties)
    {
        var result = new DeviceSettingsSnapshot();
        foreach (var rule in settingRules) {
            object raw = Property(properties, rule.Property), member;
            if (rule.Member != null) { var structure = raw as Dictionary<string, object>; raw = structure != null && structure.TryGetValue(rule.Member, out member) ? member : null; }
            int? value = SettingInteger(raw);
            if (!value.HasValue || Array.IndexOf(rule.Options, value.Value) < 0) continue;
            result.values[rule.Key] = value.Value; result.options[rule.Key] = rule.Options;
        }
        foreach (string name in new string[] { "StorageStatus", "StorageTotalCapacity", "StorageRemainCapacity", "SignalStrength" }) {
            object value = Property(properties, name);
            if (value is int || value is long || value is double || value is decimal) {
                double number = Convert.ToDouble(value);
                if (!double.IsNaN(number) && !double.IsInfinity(number) && number >= (name == "SignalStrength" ? -200 : 0) && number <= (name == "SignalStrength" ? 200 : 2147483647)) result.info[name] = number;
            }
        }
        string firmware = Property(properties, "IpcVersion") as string;
        if (firmware != null && System.Text.RegularExpressions.Regex.IsMatch(firmware, @"^[A-Za-z0-9._-]{1,128}$")) result.info["firmware"] = firmware;
        var zone = Property(properties, "TimeZoneSetting") as Dictionary<string, object>; object offset;
        if (zone != null && zone.TryGetValue("TimeZone", out offset) && offset is string && System.Text.RegularExpressions.Regex.IsMatch((string)offset, @"^[+-]\d{2}:\d{2}$")) result.info["timezone"] = offset;
        using (var sha = SHA256.Create()) result.revision = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(json.Serialize(result.values)))).Replace("-", "").ToLowerInvariant();
        return result;
    }
    static void ValidateSettingsCommand(Dictionary<string, object> command)
    {
        object raw, revision;
        if (!command.TryGetValue("revision", out revision) || !(revision is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)revision, "^[a-f0-9]{64}$") || !command.TryGetValue("changes", out raw)) throw new ControlFailure(400, "sdk_settings_invalid");
        var changes = raw as Dictionary<string, object>;
        if (changes == null || changes.Count < 1 || changes.Count > settingRules.Length) throw new ControlFailure(400, "sdk_settings_invalid");
        foreach (var pair in changes) {
            var rule = Array.Find(settingRules, candidate => candidate.Key == pair.Key); int? value = SettingInteger(pair.Value);
            if (rule == null || !value.HasValue || Array.IndexOf(rule.Options, value.Value) < 0) throw new ControlFailure(400, "sdk_settings_invalid");
        }
    }
    static Dictionary<string, object> SettingsPatch(Dictionary<string, object> properties, Dictionary<string, object> command)
    {
        ValidateSettingsCommand(command); var snapshot = SettingsFromProperties(properties);
        if (snapshot.revision != (string)command["revision"]) throw new ControlFailure(409, "sdk_settings_changed");
        var patch = new Dictionary<string, object>();
        foreach (var pair in (Dictionary<string, object>)command["changes"]) {
            var rule = Array.Find(settingRules, candidate => candidate.Key == pair.Key);
            if (!snapshot.values.ContainsKey(pair.Key)) throw new ControlFailure(422, "sdk_control_unsupported");
            if (pair.Key == "sd_recording" && SettingInteger(Property(properties, "StorageStatus")) != 1) throw new ControlFailure(409, "sdk_settings_no_card");
            if (rule.Member == null) patch[rule.Property] = pair.Value;
            else {
                object previous;
                if (!patch.TryGetValue(rule.Property, out previous)) patch[rule.Property] = previous = new Dictionary<string, object>((Dictionary<string, object>)Property(properties, rule.Property));
                ((Dictionary<string, object>)previous)[rule.Member] = pair.Value;
            }
        }
        return patch;
    }
    static void ApplySettings(TendaNative.ThingClient client, Dictionary<string, object> command, string directory, int id)
    {
        var properties = client.Properties();
        if (Switch(Property(properties, "TalkBackStartEnable")) == true || File.Exists(Path.Combine(ControlRoot, "alarm-" + id + ".json"))) throw new ControlFailure(409, "sdk_settings_busy");
        var patch = SettingsPatch(properties, command);
        if (!ParentAlive() || File.Exists(Path.Combine(directory, "stop"))) throw new ControlFailure(409, "sdk_control_cancelled");
        client.Settings(patch); DeviceControlState state = null; bool confirmed = false;
        var changes = (Dictionary<string, object>)command["changes"];
        for (int i = 0; i < 6; i++) {
            state = ControlState(client); confirmed = true;
            foreach (var pair in changes) {
                int value;
                if (!state.device_settings.values.TryGetValue(pair.Key, out value) || value != Convert.ToInt32(pair.Value)) { confirmed = false; break; }
            }
            if (confirmed) break; TendaNative.Pump(500);
        }
        Write(Path.Combine(directory, "result.json"), new { ok = true, acknowledged = true, confirmed = confirmed, state = state });
    }
}
