using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class RemoteInputHelper
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public UIntPtr dwExtraInfo;
    }
    private sealed class Message {
        public string type { get; set; }
        public double x { get; set; }
        public double y { get; set; }
        public string button { get; set; }
        public bool down { get; set; }
        public double deltaX { get; set; }
        public double deltaY { get; set; }
        public string code { get; set; }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    private static readonly HashSet<ushort> PressedKeys = new HashSet<ushort>();
    private static readonly HashSet<string> PressedButtons = new HashSet<string>();
    private static readonly Dictionary<string, ushort> NamedKeys = new Dictionary<string, ushort>(StringComparer.Ordinal) {
        { "Enter", 0x0D }, { "Escape", 0x1B }, { "Backspace", 0x08 }, { "Tab", 0x09 }, { "Space", 0x20 },
        { "Delete", 0x2E }, { "Insert", 0x2D }, { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 }, { "PageDown", 0x22 },
        { "ArrowLeft", 0x25 }, { "ArrowUp", 0x26 }, { "ArrowRight", 0x27 }, { "ArrowDown", 0x28 }, { "CapsLock", 0x14 },
        { "ShiftLeft", 0xA0 }, { "ShiftRight", 0xA1 }, { "ControlLeft", 0xA2 }, { "ControlRight", 0xA3 },
        { "AltLeft", 0xA4 }, { "AltRight", 0xA5 }, { "MetaLeft", 0x5B }, { "MetaRight", 0x5C },
        { "Minus", 0xBD }, { "Equal", 0xBB }, { "BracketLeft", 0xDB }, { "BracketRight", 0xDD }, { "Backslash", 0xDC },
        { "Semicolon", 0xBA }, { "Quote", 0xDE }, { "Comma", 0xBC }, { "Period", 0xBE }, { "Slash", 0xBF }, { "Backquote", 0xC0 },
        { "NumpadAdd", 0x6B }, { "NumpadSubtract", 0x6D }, { "NumpadMultiply", 0x6A }, { "NumpadDivide", 0x6F },
        { "NumpadDecimal", 0x6E }, { "NumpadEnter", 0x0D }
    };

    private static int ClampAbsolute(double value) {
        if (value < 0) value = 0; else if (value > 1) value = 1;
        return (int)Math.Round(value * 65535.0);
    }

    private static void SendMouse(uint flags, uint data, double x, double y) {
        var input = new INPUT {
            type = INPUT_MOUSE,
            U = new InputUnion { mi = new MOUSEINPUT {
                dx = ClampAbsolute(x), dy = ClampAbsolute(y), mouseData = data,
                dwFlags = flags, time = 0, dwExtraInfo = UIntPtr.Zero,
            } },
        };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static ushort KeyCode(string code) {
        if (String.IsNullOrEmpty(code)) return 0;
        ushort named;
        if (NamedKeys.TryGetValue(code, out named)) return named;
        if (code.StartsWith("Key", StringComparison.Ordinal) && code.Length == 4) return (ushort)code[3];
        if (code.StartsWith("Digit", StringComparison.Ordinal) && code.Length == 6) return (ushort)code[5];
        if (code.StartsWith("Numpad", StringComparison.Ordinal) && code.Length == 7 && Char.IsDigit(code[6])) return (ushort)(0x60 + (code[6] - '0'));
        if (code.StartsWith("F", StringComparison.Ordinal)) {
            int number;
            if (Int32.TryParse(code.Substring(1), out number) && number >= 1 && number <= 12) return (ushort)(0x6F + number);
        }
        return 0;
    }

    private static void SendKey(string code, bool down) {
        var key = KeyCode(code);
        if (key == 0) return;
        if (down) PressedKeys.Add(key); else PressedKeys.Remove(key);
        var input = new INPUT {
            type = INPUT_KEYBOARD,
            U = new InputUnion { ki = new KEYBDINPUT {
                wVk = key, wScan = 0, dwFlags = down ? 0U : KEYEVENTF_KEYUP,
                time = 0, dwExtraInfo = UIntPtr.Zero,
            } },
        };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void Handle(Message message) {
        if (message == null || String.IsNullOrEmpty(message.type)) return;
        if (message.type == "pointer") {
            SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, message.x, message.y);
        } else if (message.type == "button") {
            SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, message.x, message.y);
            uint flag = 0;
            if (message.button == "left") flag = message.down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
            if (message.button == "right") flag = message.down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            if (message.button == "middle") flag = message.down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            if (flag != 0) {
                if (message.down) PressedButtons.Add(message.button); else PressedButtons.Remove(message.button);
                SendMouse(flag, 0, message.x, message.y);
            }
        } else if (message.type == "wheel") {
            SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, message.x, message.y);
            if (Math.Abs(message.deltaY) >= 1) SendMouse(MOUSEEVENTF_WHEEL, unchecked((uint)(int)-message.deltaY), message.x, message.y);
            if (Math.Abs(message.deltaX) >= 1) SendMouse(MOUSEEVENTF_HWHEEL, unchecked((uint)(int)message.deltaX), message.x, message.y);
        } else if (message.type == "key") {
            SendKey(message.code, message.down);
        }
    }

    private static void ReleaseAll() {
        foreach (var key in new List<ushort>(PressedKeys)) {
            var input = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } };
            SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }
        foreach (var button in new List<string>(PressedButtons)) {
            uint flag = button == "left" ? MOUSEEVENTF_LEFTUP : button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_MIDDLEUP;
            SendMouse(flag, 0, 0, 0);
        }
        PressedKeys.Clear(); PressedButtons.Clear();
    }

    public static void Main() {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 8192 };
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                try { Handle(serializer.Deserialize<Message>(line)); } catch { }
            }
        } finally { ReleaseAll(); }
    }
}
