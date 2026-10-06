using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class ApplicationAudioSourcesNativeTests
{
    private static object Invoke(string method, params object[] args) {
        return typeof(ApplicationAudioHelper).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
    }
    private static string Id(object source) { return (string)source.GetType().GetProperty("id").GetValue(source, null); }
    private static void Check(bool condition, string name) {
        if (!condition) throw new Exception(name);
        Console.WriteLine("PASS " + name);
    }
    private static bool Listed(string id, int excludedId) {
        foreach (object source in (IEnumerable)Invoke("List", excludedId)) if (Id(source) == id) return true;
        return false;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat {
        public ushort tag, channels;
        public uint sampleRate, bytesPerSecond;
        public ushort blockAlign, bits, extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader {
        public IntPtr data;
        public uint length, recorded;
        public UIntPtr user;
        public uint flags, loops;
        public IntPtr next;
        public UIntPtr reserved;
    }
    [DllImport("winmm.dll")] private static extern uint waveOutOpen(out IntPtr handle, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] private static extern uint waveOutPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveOutWrite(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveOutPause(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveOutReset(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveOutUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveOutClose(IntPtr handle);

    [MTAThread]
    private static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "worker") { Console.WriteLine("ready"); Console.ReadLine(); return 0; }
        try {
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            foreach (string executable in new[] {
                "explorer.exe", "taskmgr.exe", "SystemSettings.exe", "SystemSettingsAdminFlows.exe",
                "control.exe", "mmc.exe", "regedit.exe", "ApplicationFrameHost.exe",
                "SearchHost.exe", "SearchApp.exe", "ShellExperienceHost.exe",
                "StartMenuExperienceHost.exe", "TextInputHost.exe", "LockApp.exe"
            }) Check((bool)Invoke("IsSystemUtility", Path.Combine(windows, "System32", executable)), "exclude system tool " + executable);
            Check((bool)Invoke("IsSystemUtility", Path.Combine(windows.ToUpperInvariant(), "ImmersiveControlPanel", "SYSTEMSETTINGS.EXE")), "system tool matching is case-insensitive");
            foreach (string executable in new[] {
                "WindowsTerminal.exe", "OpenConsole.exe", "conhost.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
                "NVIDIA App.exe", "NVIDIA Overlay.exe", "NVIDIA Share.exe", "nvcontainer.exe", "nvcplui.exe",
                "Microsoft.CmdPal.UI.exe", "Nahimic3.exe"
            }) Check((bool)Invoke("IsSystemUtility", Path.Combine(Path.GetTempPath(), "portable-tools", executable)), "exclude terminal/driver utility at any install path " + executable);
            Check((bool)Invoke("IsSystemUtility", @"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe"), "exclude Store-installed Windows Terminal");
            Check((bool)Invoke("IsSystemUtility", @"C:\Program Files\NVIDIA Corporation\NVIDIA App\CEF\NVIDIA Overlay.exe"), "exclude NVIDIA Overlay from screenshot");
            Check((bool)Invoke("IsSystemUtility", @"C:\Program Files\WindowsApps\Microsoft.CommandPalette_0.6.2963.0_x64__8wekyb3d8bbwe\Microsoft.CmdPal.UI.exe"), "exclude Store-installed Command Palette");
            Check((bool)Invoke("IsSystemUtility", @"C:\Program Files\WindowsApps\A-Volute.Nahimic_1.10.15.0_x64__w2gh52qy24etm\Nahimic3.exe"), "exclude Store-installed Nahimic 3");
            Check((bool)Invoke("IsSystemUtility", @"D:\Tools\NVIDIA OVERLAY.EXE"), "driver utility matching is case-insensitive");
            foreach (string executable in new[] { "wmplayer.exe", "msedge.exe", "Music.UI.exe", "Video.UI.exe", "Microsoft.Media.Player.exe", "cloudmusic.exe", "Qoder.exe", "Weixin.exe", "NVIDIA Game.exe", "WindowsTerminalPlayer.exe", "Microsoft.CmdPal.Player.exe", "Nahimic3Player.exe" })
                Check(!(bool)Invoke("IsSystemUtility", Path.Combine(windows, "System32", executable)), "preserve audio app " + executable);
            Check(!(bool)Invoke("IsSystemUtility", Path.Combine(Path.GetTempPath(), "taskmgr.exe")), "preserve same-name third-party executable outside Windows");
            Check(!(bool)Invoke("IsSystemUtility", windows + "Backup\\explorer.exe"), "Windows directory match respects path boundary");
            int self = Process.GetCurrentProcess().Id;
            string id = Id(Invoke("Describe", self, false));
            Check(Invoke("Resolve", id, 0) != null, "windowless process resolves without a window or audio session");
            Check(Invoke("Resolve", id + "1", 0) == null, "stale creation timestamp is rejected even when PID is live");
            Check(Invoke("Resolve", id, self) == null, "Cove itself cannot be selected");
            using (var worker = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "worker") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
            })) {
                try {
                    Check(worker.StandardOutput.ReadLine() == "ready", "audio worker fixture starts");
                    var parents = (Dictionary<int, int>)Invoke("Parents");
                    Check((int)Invoke("ApplicationRoot", worker.Id, parents) == self, "same-application child is grouped with root");
                    Check((bool)Invoke("IsExcluded", worker.Id, self, parents), "Cove child processes are excluded too");
                } finally { worker.StandardInput.WriteLine(); if (!worker.WaitForExit(3000)) worker.Kill(); }
                Check(Invoke("Resolve", "process:" + worker.Id + ":1", 0) == null, "closed application cannot be selected");
            }

            using (var form = new Form { Text = "Cove audio source regression fixture", ShowInTaskbar = false, WindowState = FormWindowState.Minimized }) {
                form.Show();
                Application.DoEvents();
                Check(Listed(id, 0), "minimized application is selectable before audio playback");
                Check(!Listed(id, self), "own window is excluded");
                form.Hide();
                Application.DoEvents();
                Check(Invoke("Resolve", id, 0) != null, "hiding a selected window does not invalidate startup");

                var format = new WaveFormat { tag = 1, channels = 2, sampleRate = 48000, bytesPerSecond = 192000, blockAlign = 4, bits = 16 };
                IntPtr handle;
                uint open = waveOutOpen(out handle, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0);
                if (open != 0) { Console.WriteLine("SKIP audio session integration: no default output (" + open + ")"); return 0; }
                IntPtr data = Marshal.AllocHGlobal(192000 * 2);
                IntPtr header = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveHeader)));
                uint size = (uint)Marshal.SizeOf(typeof(WaveHeader));
                try {
                    // Silence exercises real Core Audio without disturbing user audio.
                    Marshal.Copy(new byte[192000 * 2], 0, data, 192000 * 2);
                    Marshal.StructureToPtr(new WaveHeader { data = data, length = 192000 * 2 }, header, false);
                    Check(waveOutPrepareHeader(handle, header, size) == 0 && waveOutWrite(handle, header, size) == 0, "silent playback fixture starts");
                    var ids = new HashSet<int>();
                    Invoke("AudioProcessIds", ids);
                    Check(ids.Contains(self), "real audio session discovers hidden window player");
                    Check(Listed(id, 0), "hidden/tray-style player appears from audio session");
                    Check(waveOutPause(handle) == 0, "pause playback fixture");
                    Check(Listed(id, 0), "paused audio player remains selectable");
                    waveOutReset(handle);
                    Check(Invoke("Resolve", id, 0) != null, "stopped playback does not prevent restarting sharing");
                } finally {
                    waveOutReset(handle); waveOutUnprepareHeader(handle, header, size); waveOutClose(handle);
                    Marshal.FreeHGlobal(header); Marshal.FreeHGlobal(data);
                }
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
