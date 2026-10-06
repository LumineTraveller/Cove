using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// Discovery only: never opens a recording stream or changes volume/window state.
internal static class ApplicationAudioHelper
{
    private sealed class Source {
        public string id { get; set; }
        public string name { get; set; }
        public int processId { get; set; }
        public string processName { get; set; }
        public string iconDataUrl { get; set; }
    }

    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

    private sealed class ProcessInfo {
        public string executable;
        public long created;
    }
    private static readonly Dictionary<int, ProcessInfo> processCache = new Dictionary<int, ProcessInfo>();
    private static readonly HashSet<string> systemUtilities = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "explorer.exe", "taskmgr.exe", "SystemSettings.exe", "SystemSettingsAdminFlows.exe",
        "control.exe", "mmc.exe", "regedit.exe", "ApplicationFrameHost.exe",
        "SearchHost.exe", "SearchApp.exe", "ShellExperienceHost.exe",
        "StartMenuExperienceHost.exe", "TextInputHost.exe", "LockApp.exe"
    };
    private static readonly HashSet<string> terminalAndDriverUtilities = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "WindowsTerminal.exe", "OpenConsole.exe", "conhost.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
        "NVIDIA App.exe", "NVIDIA Overlay.exe", "NVIDIA Share.exe", "nvcontainer.exe", "nvcplui.exe",
        "Microsoft.CmdPal.UI.exe", "Nahimic3.exe"
    };

    private static bool IsSystemUtility(string executable) {
        if (String.IsNullOrEmpty(executable)) return false;
        string name = Path.GetFileName(executable);
        // Store packages, portable terminals and driver tools can live outside
        // Windows. Match only known utility executables, not vendor prefixes.
        if (terminalAndDriverUtilities.Contains(name)) return true;
        if (!systemUtilities.Contains(name)) return false;
        // Do not filter all Windows/Microsoft apps: Media Player, Edge, etc.
        // are valid audio sources. Match known system tools at Windows paths,
        // not a localized window title or a similarly named third-party app.
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        return !String.IsNullOrEmpty(windows) && Path.GetFullPath(executable).StartsWith(
            windows.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint size, usage, processId;
        public UIntPtr defaultHeapId;
        public uint moduleId, threads, parentId;
        public int basePriority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }

    // Methods preceding those used below must stay in their native vtable order.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint states, out IMMDeviceCollection devices);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2 {
        [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2 {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, IntPtr context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
    }

    private static void Release(object value) {
        if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }

    private static Dictionary<int, int> Parents() {
        var parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        try {
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) do {
                parents[(int)entry.processId] = (int)entry.parentId;
            } while (Process32Next(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        return parents;
    }

    private static bool IsExcluded(int processId, int coveId, Dictionary<int, int> parents) {
        var seen = new HashSet<int>();
        while (processId > 0 && seen.Add(processId)) {
            if (processId == coveId) return true;
            if (!parents.TryGetValue(processId, out processId)) break;
        }
        return false;
    }

    private static ProcessInfo Info(int processId) {
        ProcessInfo info;
        if (processCache.TryGetValue(processId, out info)) return info;
        info = null;
        // QueryFullProcessImageName requires only QUERY_LIMITED_INFORMATION and
        // avoids .NET's costly repeated full process/module enumeration per row.
        IntPtr process = OpenProcess(0x1000, false, processId);
        if (process != IntPtr.Zero) try {
            var executable = new StringBuilder(32768);
            uint size = (uint)executable.Capacity;
            long created, exited, kernel, user;
            if (QueryFullProcessImageName(process, 0, executable, ref size)
                && GetProcessTimes(process, out created, out exited, out kernel, out user) && exited == 0)
                info = new ProcessInfo { executable = executable.ToString(), created = DateTime.FromFileTimeUtc(created).Ticks };
        } finally { CloseHandle(process); }
        processCache[processId] = info; // Also cache unreadable/exited processes.
        return info;
    }

    private static int ApplicationRoot(int processId, Dictionary<int, int> parents) {
        ProcessInfo child = Info(processId);
        if (child == null) return processId;
        var seen = new HashSet<int>();
        int parent;
        // Group same-application audio workers, never climb into Explorer or
        // another launcher and accidentally capture unrelated applications.
        while (seen.Add(processId) && parents.TryGetValue(processId, out parent) && parent > 0) {
            ProcessInfo ancestor = Info(parent);
            if (ancestor == null || ancestor.created > child.created
                || !String.Equals(child.executable, ancestor.executable, StringComparison.OrdinalIgnoreCase)) break;
            processId = parent;
            child = ancestor;
        }
        return processId;
    }

    private static Source Describe(int processId, bool withIcon) {
        ProcessInfo process = Info(processId);
        if (process == null) return null;
        string executable = process.executable;
        string processName = Path.GetFileNameWithoutExtension(executable);
        string name = processName;
        try {
            string description = FileVersionInfo.GetVersionInfo(executable).FileDescription;
            if (!String.IsNullOrWhiteSpace(description)) name = description.Trim();
        } catch { } // Broken/missing version resources do not hide an audio app.
        var source = new Source {
            id = "process:" + processId + ":" + process.created.ToString(CultureInfo.InvariantCulture),
            processId = processId, processName = processName, name = name
        };
        if (withIcon && !String.IsNullOrEmpty(executable)) try {
            using (Icon icon = Icon.ExtractAssociatedIcon(executable))
            using (Bitmap bitmap = icon.ToBitmap())
            using (var stream = new MemoryStream()) {
                bitmap.Save(stream, ImageFormat.Png);
                source.iconDataUrl = "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
        } catch { } // Generic UI icon is sufficient if extraction fails.
        return source;
    }

    private static void AudioProcessIds(HashSet<int> ids) {
        IMMDeviceEnumerator enumerator = null;
        IMMDeviceCollection devices = null;
        try {
            enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, 1, out devices)); // All active render devices.
            uint deviceCount;
            Marshal.ThrowExceptionForHR(devices.GetCount(out deviceCount));
            for (uint d = 0; d < deviceCount; d++) {
                IMMDevice device = null;
                object managerObject = null;
                IAudioSessionEnumerator sessions = null;
                try {
                    Marshal.ThrowExceptionForHR(devices.Item(d, out device));
                    Guid iid = typeof(IAudioSessionManager2).GUID;
                    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 1, IntPtr.Zero, out managerObject));
                    var manager = (IAudioSessionManager2)managerObject;
                    Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
                    int sessionCount;
                    Marshal.ThrowExceptionForHR(sessions.GetCount(out sessionCount));
                    for (int s = 0; s < sessionCount; s++) {
                        object sessionObject = null;
                        try {
                            if (sessions.GetSession(s, out sessionObject) < 0) continue;
                            var session = (IAudioSessionControl2)sessionObject;
                            int state;
                            uint id;
                            // Keep inactive/paused sessions; only expired ones
                            // and system sounds are ineligible. No peak threshold.
                            if (session.GetState(out state) >= 0 && state != 2
                                && session.IsSystemSoundsSession() != 0
                                && session.GetProcessId(out id) >= 0 && id > 0)
                                ids.Add((int)id);
                        } catch (Exception error) { Console.Error.WriteLine("Audio session: " + error.Message); }
                        finally { Release(sessionObject); }
                    }
                } catch (Exception error) { Console.Error.WriteLine("Audio device: " + error.Message); }
                finally { Release(sessions); Release(managerObject); Release(device); }
            }
        } finally { Release(devices); Release(enumerator); }
    }

    private static List<Source> List(int coveId) {
        processCache.Clear();
        var parents = Parents();
        var ids = new HashSet<int>();
        // Preserve ordinary selectable applications, including minimized ones.
        // Tray-only/background players are added independently by Core Audio.
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(window, title, title.Capacity) <= 0) return true;
            uint id;
            GetWindowThreadProcessId(window, out id);
            if (id > 0) ids.Add((int)id);
            return true;
        }, IntPtr.Zero);
        try { AudioProcessIds(ids); }
        catch (Exception error) { Console.Error.WriteLine("Audio discovery: " + error.Message); }
        var roots = new HashSet<int>();
        var sources = new List<Source>();
        foreach (int id in ids) try {
            if (IsExcluded(id, coveId, parents)) continue;
            int root = ApplicationRoot(id, parents);
            if (IsExcluded(root, coveId, parents) || !roots.Add(root)) continue;
            ProcessInfo info = Info(root);
            if (info == null || IsSystemUtility(info.executable)) continue;
            var source = Describe(root, true);
            if (source != null) sources.Add(source);
        } catch { } // Process can exit between any two discovery calls.
        sources.Sort(delegate(Source a, Source b) { return String.Compare(a.name, b.name, StringComparison.CurrentCulture); });
        return sources;
    }

    private static Source Resolve(string sourceId, int coveId) {
        processCache.Clear();
        string[] parts = sourceId.Split(':');
        int id;
        long ticks;
        if (parts.Length != 3 || parts[0] != "process" || !Int32.TryParse(parts[1], out id) || id <= 0
            || !Int64.TryParse(parts[2], out ticks) || ticks <= 0 || IsExcluded(id, coveId, Parents())) return null;
        try {
            ProcessInfo info = Info(id);
            if (info == null || IsSystemUtility(info.executable)) return null;
            Source source = Describe(id, false);
            // A window may be hidden and the session may be paused/removed since
            // selection. Only process identity matters, including PID reuse.
            return source != null && source.id == sourceId ? source : null;
        } catch { return null; }
    }

    [MTAThread]
    private static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            int coveId;
            if (args.Length < 2 || !Int32.TryParse(args[1], out coveId) || coveId < 0) return 2;
            var json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
            if (args[0] == "list" && args.Length == 2) Console.WriteLine(json.Serialize(List(coveId)));
            else if (args[0] == "resolve" && args.Length == 3) Console.WriteLine(json.Serialize(Resolve(args[2], coveId)));
            else return 2;
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
