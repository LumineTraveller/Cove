using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

// Geometry only. No capture, input injection or access to application data.
internal static class AnnotationWindowHelper {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
    static int Main(string[] args) {
        if (args.Length != 2) return 1;
        long handle; int parentId;
        if (!long.TryParse(args[0], out handle) || !int.TryParse(args[1], out parentId)) return 1;
        var hwnd = new IntPtr(handle);
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        uint initialPid; GetWindowThreadProcessId(hwnd, out initialPid);
        if (initialPid == 0 || !IsWindow(hwnd)) { Console.WriteLine("{\"closed\":true}"); return 0; }
        var className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        // The baseline's Chromium-window capture path returns the client area,
        // including for a BrowserWindow with a native titlebar.
        bool chromiumClient = className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
        try {
            using (var parent = Process.GetProcessById(parentId)) {
                string previous = null;
                while (!parent.HasExited) {
                    uint pid; GetWindowThreadProcessId(hwnd, out pid);
                    if (!IsWindow(hwnd) || pid != initialPid) { Console.WriteLine("{\"closed\":true}"); return 0; }
                    Rect rect;
                    if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(hwnd, out rect)) {
                        if (!IsWindow(hwnd)) { Console.WriteLine("{\"closed\":true}"); return 0; }
                        return 1;
                    }
                    // Frameless windows have an invisible resize border outside
                    // the WGC content. Use their physical client box, not DWM's
                    // expanded outer box. Other captioned windows include the titlebar.
                    {
                        Rect client; var origin = new Point();
                        // Chromium retains WS_CAPTION even for a custom/frameless
                        // non-client area. The physical client origin reveals
                        // whether there is an actual titlebar above the content.
                        if (GetClientRect(hwnd, out client) && ClientToScreen(hwnd, ref origin) && (chromiumClient || origin.Y <= rect.Top + 2)) {
                            rect.Left = origin.X; rect.Top = origin.Y;
                            rect.Right = origin.X + client.Right; rect.Bottom = origin.Y + client.Bottom;
                        }
                    }
                    var foreground = GetForegroundWindow();
                    bool sourceVisible = IsWindowVisible(hwnd) && !IsIconic(hwnd);
                    bool visible = sourceVisible &&
                        (foreground == hwnd || GetAncestor(foreground, 2) == hwnd);
                    string current = "{\"visible\":" + (visible ? "true" : "false") + ",\"sourceVisible\":" + (sourceVisible ? "true" : "false") + ",\"bounds\":{\"x\":" + rect.Left +
                        ",\"y\":" + rect.Top + ",\"width\":" + (rect.Right-rect.Left) + ",\"height\":" + (rect.Bottom-rect.Top) + "}}";
                    if (current != previous) { Console.WriteLine(current); Console.Out.Flush(); previous = current; }
                    Thread.Sleep(100);
                }
            }
        } catch { return 1; }
        return 0;
    }
}
