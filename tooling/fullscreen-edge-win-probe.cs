using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Read-only HWND geometry and WM_NCHITTEST. No keyboard/mouse injection or capture.
internal static class FullscreenEdgeProbe {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    delegate IntPtr HookProc(int code,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int kind,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr w,IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    static volatile bool activity,monitorActive,expectMove;
    static volatile int expectedX,expectedY,expectedKey;
    static uint hookThreadId;
    static readonly HookProc mouseHook=MouseInput,keyboardHook=KeyboardInput;
    static void Activity(string kind) {
        if(!monitorActive||activity)return;
        activity=true;
        // Only a boolean is emitted; no user keycodes or unrelated mouse path.
        Console.WriteLine("{\"userActivity\":true,\"kind\":\""+kind+"\"}");Console.Out.Flush();
    }
    static IntPtr MouseInput(int code,IntPtr w,IntPtr l) {
        if(code>=0&&monitorActive) {
            var injected=(Marshal.ReadInt32(l,12)&1)!=0;
            var x=Marshal.ReadInt32(l,0);var y=Marshal.ReadInt32(l,4);
            if(!injected)Activity("physical-mouse");
            else if(w.ToInt64()!=0x200 || !expectMove || Math.Abs(x-expectedX)>1 || Math.Abs(y-expectedY)>1)Activity("foreign-injected-mouse");
        }
        return CallNextHookEx(IntPtr.Zero,code,w,l);
    }
    static IntPtr KeyboardInput(int code,IntPtr w,IntPtr l) {
        if(code>=0&&monitorActive) {
            var injected=(Marshal.ReadInt32(l,8)&0x10)!=0;
            if(!injected || Marshal.ReadInt32(l,0)!=expectedKey)Activity(injected?"foreign-injected-keyboard":"physical-keyboard");
        }
        return CallNextHookEx(IntPtr.Zero,code,w,l);
    }
    static int Hit(IntPtr hwnd,int x,int y) {
        UIntPtr result;
        var xy=new IntPtr(unchecked((y<<16)|(x&0xffff)));
        return SendMessageTimeout(hwnd,0x84,UIntPtr.Zero,xy,2,100,out result)==IntPtr.Zero ? -999 : unchecked((int)result.ToUInt64());
    }
    public static void Main(string[] args) {
        SetProcessDPIAware();
        if(args[0]=="--cursor-stdin") {
            // An explicitly coordinated owned-window test uses this mode to
            // independently observe SendInput. It only restores the original
            // cursor on request; it never clicks, types or records the screen.
            var serializer=new JavaScriptSerializer();POINT original;GetCursorPos(out original);
            var foreground=GetForegroundWindow();var hooked=false;var started=new ManualResetEvent(false);
            var thread=new Thread(delegate() {
                hookThreadId=GetCurrentThreadId();
                var m=SetWindowsHookEx(14,mouseHook,GetModuleHandle(null),0);
                var k=SetWindowsHookEx(13,keyboardHook,GetModuleHandle(null),0);
                hooked=m!=IntPtr.Zero&&k!=IntPtr.Zero;monitorActive=hooked;started.Set();
                try { if(hooked)Application.Run(); }
                finally { monitorActive=false;if(m!=IntPtr.Zero)UnhookWindowsHookEx(m);if(k!=IntPtr.Zero)UnhookWindowsHookEx(k); }
            });thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();started.WaitOne(1000);
            Console.WriteLine(serializer.Serialize(new {ready=true,activityMonitorAvailable=hooked,original=original,originalForeground=foreground.ToInt64()}));Console.Out.Flush();
            try {
                string line;
                while((line=Console.ReadLine())!=null) {
                    if(line=="restore")break;
                    var request=serializer.Deserialize<Dictionary<string,object>>(line);
                    var target=new POINT {x=Convert.ToInt32(request["x"]),y=Convert.ToInt32(request["y"])};
                    expectedX=target.x;expectedY=target.y;expectedKey=request.ContainsKey("expectedKey")?Convert.ToInt32(request["expectedKey"]):0;expectMove=true;
                    POINT actual;GetCursorPos(out actual);
                    var held=(GetAsyncKeyState(1)&0x8000)!=0 || (GetAsyncKeyState(0x10)&0x8000)!=0 || (GetAsyncKeyState(0x11)&0x8000)!=0 || (GetAsyncKeyState(0x12)&0x8000)!=0;
                    Console.WriteLine(serializer.Serialize(new {actual=actual,ownerAtTarget=GetAncestor(WindowFromPoint(target),2).ToInt64(),held=held,
                        foreground=GetForegroundWindow().ToInt64(),escapeHeld=(GetAsyncKeyState(0x1b)&0x8000)!=0,userActivityObserved=activity}));Console.Out.Flush();
                }
            } finally {
                monitorActive=false;PostThreadMessage(hookThreadId,0x12,UIntPtr.Zero,IntPtr.Zero);thread.Join(300);
                var restored=!activity&&SetCursorPos(original.x,original.y);
                if(!activity&&IsWindow(foreground))SetForegroundWindow(foreground);
                POINT final;GetCursorPos(out final);
                Console.WriteLine(serializer.Serialize(new {cleanup=true,userActivityObserved=activity,cursorRestored=restored,actual=final,
                    foregroundRestored=GetForegroundWindow()==foreground,restoreSkippedForUserActivity=activity}));Console.Out.Flush();
            }
            return;
        }
        var hwnd=args[0]=="--pid" ? Process.GetProcessById(Int32.Parse(args[1])).MainWindowHandle : new IntPtr(Int64.Parse(args[0]));
        if(hwnd==IntPtr.Zero)throw new Exception("No top-level window");
        RECT outer,client;GetWindowRect(hwnd,out outer);GetClientRect(hwnd,out client);
        var origin=new POINT();ClientToScreen(hwnd,ref origin);
        var rows=new List<object>();
        foreach(var y in new[]{outer.top,origin.y,origin.y+1,origin.y+2,origin.y+10}) {
            foreach(var x in new[]{outer.left,outer.left+1,(outer.left+outer.right)/2,outer.right-2,outer.right-1})
                rows.Add(new {x=x,y=y,hit=Hit(hwnd,x,y)});
        }
        var displays=new List<object>();
        foreach(var s in Screen.AllScreens)displays.Add(new {primary=s.Primary,bounds=s.Bounds,workingArea=s.WorkingArea});
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {observedAt=DateTime.UtcNow.ToString("o"),hwnd=hwnd.ToInt64(),visible=IsWindowVisible(hwnd),outer=outer,client=client,clientOrigin=origin,rows=rows,displays=displays}));
    }
}
