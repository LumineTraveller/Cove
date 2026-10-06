using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Owned test window only. Real pointer moves, no clicks, keys, wheel or user-screen recording.
internal sealed class PointerProbe : Form {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    readonly List<object> moves = new List<object>();
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly string helperPath, output;
    readonly bool observeOnly;
    protected override bool ShowWithoutActivation { get { return true; } }
    public PointerProbe(string helper, string destination) {
        helperPath = helper; output = destination; observeOnly = helper == "--observe";
        Text = "Cove owned remote pointer measurement — no clicks or keys";
        Size = new Size(680, 400); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(22, 29, 39); ForeColor = Color.White;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Paint += delegate(object s, PaintEventArgs e) {
            e.Graphics.DrawString("Measuring actual Windows cursor movement\nOnly this test rectangle receives pointer moves.", Font, Brushes.White, 24, 24);
        };
        MouseMove += delegate(object s, MouseEventArgs e) { lock(moves) moves.Add(new { ms = clock.Elapsed.TotalMilliseconds, x = e.X, y = e.Y }); };
        Shown += delegate {
            var bounds = RectangleToScreen(ClientRectangle);
            var thread = new Thread(delegate() { if(observeOnly) Observe(bounds); else RunProbe(bounds); }); thread.IsBackground = true; thread.Start();
        };
    }
    void Observe(Rectangle bounds) {
        var serializer = new JavaScriptSerializer(); POINT original; GetCursorPos(out original);
        var initialHeld=Held();
        Console.WriteLine(serializer.Serialize(new { ready=true, initialHeld=initialHeld, screenWidth=GetSystemMetrics(0), screenHeight=GetSystemMetrics(1),
            bounds=new {left=bounds.Left,top=bounds.Top,width=bounds.Width,height=bounds.Height} })); Console.Out.Flush();
        Console.ReadLine(); var rows=new List<object>(); var keys=new List<object>(); var start=Stopwatch.GetTimestamp();
        var previousHeld=initialHeld;
        POINT last=original;
        while((Stopwatch.GetTimestamp()-start)/(double)Stopwatch.Frequency < 6) {
            POINT current; GetCursorPos(out current);
            if(current.x!=last.x || current.y!=last.y) {
                rows.Add(new {ms=(Stopwatch.GetTimestamp()-start)*1000.0/Stopwatch.Frequency,x=current.x,y=current.y}); last=current;
            }
            var held=Held(); if(held!=previousHeld) { keys.Add(new {ms=(Stopwatch.GetTimestamp()-start)*1000.0/Stopwatch.Frequency,held=held}); previousHeld=held; }
            Thread.Sleep(0); Thread.SpinWait(1000);
        }
        File.WriteAllText(output,serializer.Serialize(new {observedUTC=DateTime.UtcNow.ToString("o"),rows=rows,keyChanges=keys,finalHeld=Held()}));
        SetCursorPos(original.x,original.y); BeginInvoke(new Action(Close));
    }
    static string Held() {
        var names=new List<string>(); var codes=new int[]{1,0x10,0x11,0x12,0x58}; var labels=new string[]{"left","shift","control","alt","x"};
        for(int i=0;i<codes.Length;i++) if((GetAsyncKeyState(codes[i]) & 0x8000)!=0) names.Add(labels[i]);
        return String.Join(",",names.ToArray());
    }
    void RunProbe(Rectangle bounds) {
        POINT original; GetCursorPos(out original);
        Process helper = null; var rows = new List<object>(); string error = null;
        var width = GetSystemMetrics(0); var height = GetSystemMetrics(1);
        try {
            helper = Process.Start(new ProcessStartInfo(helperPath, "0") { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true });
            if (helper.StandardOutput.ReadLine() != "{\"ready\":true}") throw new Exception("Helper readiness failed");
            Thread.Sleep(650);
            var serializer = new JavaScriptSerializer(); var start = clock.Elapsed.TotalMilliseconds;
            for(int i=0;i<150;i++) {
                while(clock.Elapsed.TotalMilliseconds < start+i*8) { Thread.Sleep(0); Thread.SpinWait(1000); }
                var px = bounds.Left+80+(i%75)*6; var py = bounds.Top+100+(i<75?0:70);
                double x = px/(double)(width-1), y = py/(double)(height-1);
                var before = clock.Elapsed.TotalMilliseconds;
                helper.StandardInput.WriteLine(serializer.Serialize(new { type="pointer", seq=i+1, x=x, y=y })); helper.StandardInput.Flush();
                var ack = helper.StandardOutput.ReadLine(); var after = clock.Elapsed.TotalMilliseconds;
                if(ack != "{\"seq\":"+(i+1)+"}") throw new Exception("Unexpected ACK: "+ack);
                POINT actual; GetCursorPos(out actual);
                rows.Add(new { index=i, sentMs=before, acknowledgedMs=after, ackMs=after-before, targetX=px, targetY=py,
                    actualX=actual.x, actualY=actual.y, errorPixels=Math.Sqrt((actual.x-px)*(actual.x-px)+(actual.y-py)*(actual.y-py)) });
            }
            helper.StandardInput.WriteLine("{\"type\":\"stop\"}"); helper.StandardInput.Close();
            if(!helper.WaitForExit(3000)) throw new Exception("Helper failed to stop");
            Thread.Sleep(100);
            Invoke(new Action(delegate {
                using(var bitmap = new Bitmap(ClientSize.Width,ClientSize.Height)) {
                    using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.Location,Point.Empty,ClientSize);
                    bitmap.Save(Path.ChangeExtension(output,"png"),System.Drawing.Imaging.ImageFormat.Png);
                }
            }));
        } catch(Exception e) { error=e.ToString(); }
        finally {
            if(helper!=null && !helper.HasExited) { try { helper.StandardInput.WriteLine("{\"type\":\"stop\"}");helper.StandardInput.Close();helper.WaitForExit(1000); } catch {} }
            SetCursorPos(original.x,original.y);
            object[] observed; lock(moves) observed=moves.ToArray();
            File.WriteAllText(output,new JavaScriptSerializer().Serialize(new { observedUTC=DateTime.UtcNow.ToString("o"),
                helper=helperPath, screenWidth=width,screenHeight=height,bounds=bounds,realWindowsInjection=true,rows=rows,windowMouseMoves=observed,error=error }));
            BeginInvoke(new Action(Close));
        }
    }
    [STAThread] public static void Main(string[] args) { SetProcessDPIAware(); Application.EnableVisualStyles(); Application.Run(new PointerProbe(args[0],args[1])); }
}
