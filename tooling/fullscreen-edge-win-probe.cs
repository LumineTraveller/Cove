using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
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
            Console.WriteLine(serializer.Serialize(new {ready=true,original=original}));Console.Out.Flush();
            string line;
            while((line=Console.ReadLine())!=null) {
                if(line=="restore") { SetCursorPos(original.x,original.y);break; }
                var target=serializer.Deserialize<POINT>(line);POINT actual;GetCursorPos(out actual);
                var held=(GetAsyncKeyState(1)&0x8000)!=0 || (GetAsyncKeyState(0x10)&0x8000)!=0 || (GetAsyncKeyState(0x11)&0x8000)!=0 || (GetAsyncKeyState(0x12)&0x8000)!=0;
                Console.WriteLine(serializer.Serialize(new {actual=actual,ownerAtTarget=GetAncestor(WindowFromPoint(target),2).ToInt64(),held=held}));Console.Out.Flush();
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
